import * as vscode from 'vscode'

import { BotResponseMultiplexer } from '@sourcegraph/cody-shared/src/chat/bot-response-multiplexer'
import { ChatClient } from '@sourcegraph/cody-shared/src/chat/chat'
import { getPreamble } from '@sourcegraph/cody-shared/src/chat/preamble'
import { Recipe, RecipeID } from '@sourcegraph/cody-shared/src/chat/recipes/recipe'
import { Transcript } from '@sourcegraph/cody-shared/src/chat/transcript'
import { ChatHistory, ChatMessage, UserLocalHistory } from '@sourcegraph/cody-shared/src/chat/transcript/messages'
import { reformatBotMessage } from '@sourcegraph/cody-shared/src/chat/viewHelpers'
import { annotateAttribution, Guardrails } from '@sourcegraph/cody-shared/src/guardrails'
import { IntentDetector } from '@sourcegraph/cody-shared/src/intent-detector'
import * as plugins from '@sourcegraph/cody-shared/src/plugins/api'
import { PluginFunctionExecutionInfo } from '@sourcegraph/cody-shared/src/plugins/api/types'
import { defaultPlugins } from '@sourcegraph/cody-shared/src/plugins/built-in'
import { ANSWER_TOKENS, DEFAULT_MAX_TOKENS } from '@sourcegraph/cody-shared/src/prompt/constants'
import { Message } from '@sourcegraph/cody-shared/src/sourcegraph-api'
import { TelemetryService } from '@sourcegraph/cody-shared/src/telemetry'

import { VSCodeEditor } from '../editor/vscode-editor'
import { PlatformContext } from '../extension.common'
import { debug } from '../log'
import { CodyPromptType } from '../my-cody/types'
import { FixupTask } from '../non-stop/FixupTask'
import { IdleRecipeRunner } from '../non-stop/roles'
import { AuthProvider, isNetworkError } from '../services/AuthProvider'
import { LocalStorage } from '../services/LocalStorageProvider'
import { TestSupport } from '../test-support'

import { ContextProvider } from './ContextProvider'

/**
 * The problem with a token limit for the prompt is that we can only
 * estimate tokens (and do so in a very cheap way), so it can be that
 * we undercount tokens. If we exceed the maximum tokens, things will
 * start to break, so we should have some safety cushion for when we're wrong in estimating.
 *
 * Ie.: Long text, 10000 characters, we estimate it to be 2500 tokens.
 * That would fit into a limit of 3000 tokens easily. Now, it's actually
 * 3500 tokens, because it splits weird and our estimation is off, it will
 * fail. That's where we want to add this safety cushion in.
 */
const SAFETY_PROMPT_TOKENS = 100

/**
 * A derived class of MessageProvider must implement these handler methods.
 * This contract ensures that MessageProvider is focused solely on building, sending and receiving messages.
 * It does not assume anything about how those messages will be displayed to the user.
 */
abstract class MessageHandler {
    protected abstract handleTranscript(transcript: ChatMessage[], messageInProgress: boolean): void
    protected abstract handleHistory(history: UserLocalHistory): void
    protected abstract handleError(errorMsg: string): void
    protected abstract handleSuggestions(suggestions: string[]): void
    protected abstract handleEnabledPlugins(plugins: string[]): void
    protected abstract handleMyPrompts(prompts: string[], isEnabled: boolean): void
    protected abstract handleTranscriptErrors(transciptError: boolean): void
}

export interface MessageProviderOptions {
    chat: ChatClient
    intentDetector: IntentDetector
    guardrails: Guardrails
    editor: VSCodeEditor
    localStorage: LocalStorage
    authProvider: AuthProvider
    contextProvider: ContextProvider
    telemetryService: TelemetryService
    platform: Pick<PlatformContext, 'recipes'>
}

export abstract class MessageProvider extends MessageHandler implements vscode.Disposable, IdleRecipeRunner {
    public currentChatID = ''

    // input and chat history are shared across all MessageProvider instances
    protected static inputHistory: string[] = []
    protected static chatHistory: ChatHistory = {}

    private isMessageInProgress = false
    private cancelCompletionCallback: (() => void) | null = null

    // Allows recipes to hook up subscribers to process sub-streams of bot output
    private multiplexer: BotResponseMultiplexer = new BotResponseMultiplexer()

    protected transcript: Transcript = new Transcript()
    protected disposables: vscode.Disposable[] = []

    protected chat: ChatClient
    protected intentDetector: IntentDetector
    protected guardrails: Guardrails
    protected readonly editor: VSCodeEditor
    protected localStorage: LocalStorage
    protected authProvider: AuthProvider
    protected contextProvider: ContextProvider
    protected telemetryService: TelemetryService
    protected platform: Pick<PlatformContext, 'recipes'>

    constructor(options: MessageProviderOptions) {
        super()

        if (TestSupport.instance) {
            TestSupport.instance.messageProvider.set(this)
        }

        this.chat = options.chat
        this.intentDetector = options.intentDetector
        this.guardrails = options.guardrails
        this.editor = options.editor
        this.localStorage = options.localStorage
        this.authProvider = options.authProvider
        this.contextProvider = options.contextProvider
        this.telemetryService = options.telemetryService
        this.platform = options.platform

        // chat id is used to identify chat session
        this.createNewChatID()

        // Listen to configuration changes to possibly enable custom recipes
        this.contextProvider.configurationChangeEvent.event(() => this.sendMyPrompts())
    }

    protected async init(): Promise<void> {
        this.loadChatHistory()
        this.sendTranscript()
        this.sendHistory()
        this.sendEnabledPlugins(this.localStorage.getEnabledPlugins() ?? [])
        await this.loadRecentChat()
        await this.contextProvider.init()
        await this.sendMyPrompts()
    }

    private idleCallbacks_: (() => void)[] = []

    private get isIdle(): boolean {
        // TODO: Use a cooldown timer for typing and interaction
        return !this.isMessageInProgress
    }

    private scheduleIdleRecipes(): void {
        setTimeout(() => {
            if (!this.isIdle) {
                // We rely on the recipe ending re-scheduling idle recipes
                return
            }
            const notifyIdle = this.idleCallbacks_.shift()
            if (!notifyIdle) {
                return
            }
            try {
                notifyIdle()
            } catch (error) {
                console.error(error)
            }
            if (this.idleCallbacks_.length) {
                this.scheduleIdleRecipes()
            }
        }, 1000)
    }

    public onIdle(callback: () => void): void {
        if (this.isIdle) {
            // Run "now", but not synchronously on this callstack.
            void Promise.resolve().then(callback)
        } else {
            this.idleCallbacks_.push(callback)
        }
    }

    public runIdleRecipe(recipeId: RecipeID, humanChatInput?: string): Promise<void> {
        if (!this.isIdle) {
            throw new Error('not idle')
        }
        return this.executeRecipe(recipeId, humanChatInput)
    }

    public async clearAndRestartSession(): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.createNewChatID()
        this.cancelCompletion()
        this.isMessageInProgress = false
        this.transcript.reset()
        this.handleSuggestions([])
        this.sendTranscript()
        this.sendHistory()
    }

    public async clearHistory(): Promise<void> {
        MessageProvider.chatHistory = {}
        MessageProvider.inputHistory = []
        await this.localStorage.removeChatHistory()
    }

    /**
     * Restores a session from a chatID
     */
    public async restoreSession(chatID: string): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.cancelCompletion()
        this.currentChatID = chatID
        this.transcript = Transcript.fromJSON(MessageProvider.chatHistory[chatID])
        await this.transcript.toJSON()
        this.sendTranscript()
        this.sendHistory()
    }

    private sendEnabledPlugins(plugins: string[]): void {
        this.handleEnabledPlugins(plugins)
    }

    private createNewChatID(): void {
        this.currentChatID = new Date(Date.now()).toUTCString()
    }

    private sendPrompt(promptMessages: Message[], responsePrefix = ''): void {
        this.cancelCompletion()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', true)

        let text = ''

        this.multiplexer.sub(BotResponseMultiplexer.DEFAULT_TOPIC, {
            onResponse: (content: string) => {
                text += content
                const displayText = reformatBotMessage(text, responsePrefix)
                this.transcript.addAssistantResponse(displayText)
                this.sendTranscript()
                return Promise.resolve()
            },
            onTurnComplete: async () => {
                const lastInteraction = this.transcript.getLastInteraction()
                if (lastInteraction) {
                    let displayText = reformatBotMessage(text, responsePrefix)
                    // TODO(keegancsmith) guardrails may be slow, we need to make this async update the interaction.
                    displayText = await this.guardrailsAnnotateAttributions(displayText)
                    this.transcript.addAssistantResponse(text || '', displayText)
                }
                await this.onCompletionEnd()
            },
        })

        let textConsumed = 0

        this.cancelCompletionCallback = this.chat.chat(promptMessages, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void this.multiplexer.publish(text)
            },
            onComplete: () => {
                void this.multiplexer.notifyTurnComplete()
            },
            onError: (err, statusCode) => {
                // TODO notify the multiplexer of the error
                debug('ChatViewProvider:onError', err)

                if (isAbortError(err)) {
                    return
                }
                // Log users out on unauth error
                if (statusCode && statusCode >= 400 && statusCode <= 410) {
                    this.authProvider
                        .auth(
                            this.contextProvider.config.serverEndpoint,
                            this.contextProvider.config.accessToken,
                            this.contextProvider.config.customHeaders
                        )
                        .catch(error => console.error(error))
                    debug('ChatViewProvider:onError:unauthUser', err, { verbose: { statusCode } })
                }

                if (isNetworkError(err)) {
                    err = 'Cody could not respond due to network error.'
                }
                // Display error message as assistant response
                this.transcript.addErrorAsAssistantResponse(err)
                this.handleTranscriptErrors(true)
                // We ignore embeddings errors in this instance because we're already showing an
                // error message and don't want to overwhelm the user.
                void this.onCompletionEnd(true)
                console.error(`Completion request failed: ${err}`)
            },
        })
    }

    protected cancelCompletion(): void {
        this.cancelCompletionCallback?.()
        this.cancelCompletionCallback = null
    }

    protected async onCompletionEnd(ignoreEmbeddingsError: boolean = false): Promise<void> {
        this.isMessageInProgress = false
        this.cancelCompletionCallback = null
        this.sendTranscript()
        await this.saveTranscriptToChatHistory()
        this.sendHistory()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', false)
        if (!ignoreEmbeddingsError) {
            this.logEmbeddingsSearchErrors()
        }
        this.scheduleIdleRecipes()
    }

    protected async abortCompletion(): Promise<void> {
        this.cancelCompletion()
        await this.multiplexer.notifyTurnComplete()
        await this.onCompletionEnd()
    }

    private async getPluginsContext(
        humanChatInput: string
    ): Promise<{ prompt?: Message[]; executionInfos?: PluginFunctionExecutionInfo[] }> {
        this.telemetryService.log('CodyVSCodeExtension:getPluginsContext:used')
        const enabledPluginNames = this.localStorage.getEnabledPlugins() ?? []
        const enabledPlugins = defaultPlugins.filter(plugin => enabledPluginNames.includes(plugin.name))
        if (enabledPlugins.length === 0) {
            return {}
        }
        this.telemetryService.log('CodyVSCodeExtension:getPluginsContext:enabledPlugins', { names: enabledPluginNames })

        this.transcript.addAssistantResponse('', 'Identifying applicable plugins...\n')
        this.sendTranscript()

        const { prompt: previousMessages } = await this.transcript.getPromptForLastInteraction(
            [],
            this.maxPromptTokens,
            [],
            true
        )

        try {
            this.telemetryService.log('CodyVSCodeExtension:getPluginsContext:chooseDataSourcesUsed')
            const descriptors = await plugins.chooseDataSources(
                humanChatInput,
                this.chat,
                enabledPlugins,
                previousMessages
            )
            this.telemetryService.log('CodyVSCodeExtension:getPluginsContext:descriptorsFound', {
                count: descriptors.length,
            })
            if (descriptors.length !== 0) {
                this.transcript.addAssistantResponse(
                    '',
                    `Using ${descriptors
                        .map(descriptor => descriptor.pluginName)
                        .join(', ')} for additional context...\n`
                )
                this.sendTranscript()

                this.telemetryService.log('CodyVSCodeExtension:getPluginsContext:runPluginFunctionsCalled', {
                    count: descriptors.length,
                })
                return await plugins.runPluginFunctions(descriptors, this.contextProvider.config.pluginsConfig)
            }
        } catch (error) {
            console.error('Error getting plugin context', error)
        }
        return {}
    }

    private getRecipe(id: RecipeID): Recipe | undefined {
        return this.platform.recipes.find(recipe => recipe.id === id)
    }

    public async executeRecipe(recipeId: RecipeID, humanChatInput = ''): Promise<void> {
        debug('ChatViewProvider:executeRecipe', recipeId, { verbose: humanChatInput })
        if (this.isMessageInProgress) {
            this.handleError('Cannot execute multiple recipes. Please wait for the current recipe to finish.')
            return
        }

        const recipe = this.getRecipe(recipeId)
        if (!recipe) {
            debug('ChatViewProvider:executeRecipe', 'no recipe found')
            return
        }

        // Create a new multiplexer to drop any old subscribers
        this.multiplexer = new BotResponseMultiplexer()

        const interaction = await recipe.getInteraction(humanChatInput, {
            editor: this.editor,
            intentDetector: this.intentDetector,
            codebaseContext: this.contextProvider.context,
            responseMultiplexer: this.multiplexer,
            firstInteraction: this.transcript.isEmpty,
        })
        if (!interaction) {
            return
        }
        this.isMessageInProgress = true
        this.transcript.addInteraction(interaction)

        let pluginsPrompt: Message[] = []
        let pluginExecutionInfos: PluginFunctionExecutionInfo[] = []
        if (this.contextProvider.config.pluginsEnabled && recipeId === 'chat-question') {
            const result = await this.getPluginsContext(humanChatInput)
            pluginsPrompt = result?.prompt ?? []
            pluginExecutionInfos = result?.executionInfos ?? []
        }

        // Check whether or not to connect to LLM backend for responses
        // Ex: performing fuzzy / context-search does not require responses from LLM backend
        switch (recipeId) {
            case 'context-search':
                await this.onCompletionEnd()
                break
            default: {
                this.sendTranscript()

                const myPremade = this.editor.controllers.prompt?.getMyPrompts().premade
                const { prompt, contextFiles } = await this.transcript.getPromptForLastInteraction(
                    getPreamble(this.contextProvider.context.getCodebase(), myPremade),
                    this.maxPromptTokens,
                    pluginsPrompt
                )
                this.transcript.setUsedContextFilesForLastInteraction(contextFiles, pluginExecutionInfos)
                this.sendPrompt(prompt, interaction.getAssistantMessage().prefix ?? '')
                await this.saveTranscriptToChatHistory()
            }
        }
        this.telemetryService.log(`CodyVSCodeExtension:recipe:${recipe.id}:executed`)
    }

    protected async runRecipeForSuggestion(recipeId: RecipeID, humanChatInput: string = ''): Promise<void> {
        const recipe = this.getRecipe(recipeId)
        if (!recipe) {
            return
        }

        const multiplexer = new BotResponseMultiplexer()
        const transcript = Transcript.fromJSON(await this.transcript.toJSON())

        const interaction = await recipe.getInteraction(humanChatInput, {
            editor: this.editor,
            intentDetector: this.intentDetector,
            codebaseContext: this.contextProvider.context,
            responseMultiplexer: multiplexer,
            firstInteraction: this.transcript.isEmpty,
        })
        if (!interaction) {
            return
        }
        transcript.addInteraction(interaction)

        const myPremade = this.editor.controllers.prompt?.getMyPrompts().premade
        const { prompt, contextFiles } = await transcript.getPromptForLastInteraction(
            getPreamble(this.contextProvider.context.getCodebase(), myPremade),
            this.maxPromptTokens
        )
        transcript.setUsedContextFilesForLastInteraction(contextFiles)

        this.telemetryService.log(`CodyVSCodeExtension:recipe:${recipe.id}:executed`)

        let text = ''
        multiplexer.sub(BotResponseMultiplexer.DEFAULT_TOPIC, {
            onResponse: (content: string) => {
                text += content
                return Promise.resolve()
            },
            onTurnComplete: () => {
                const suggestions = text
                    .split('\n')
                    .slice(0, 3)
                    .map(line => line.trim().replace(/^-/, '').trim())
                this.handleSuggestions(suggestions)
                return Promise.resolve()
            },
        })

        let textConsumed = 0
        this.chat.chat(prompt, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void multiplexer.publish(text)
            },
            onComplete: () => {
                void multiplexer.notifyTurnComplete()
            },
            onError: (error, statusCode) => {
                console.error(error, statusCode)
            },
        })
    }

    private async guardrailsAnnotateAttributions(text: string): Promise<string> {
        if (!this.contextProvider.config.experimentalGuardrails) {
            return text
        }

        const result = await annotateAttribution(this.guardrails, text)

        // Only log telemetry if we did work (ie had to annotate something).
        if (result.codeBlocks > 0) {
            this.telemetryService.log('CodyVSCodeExtension:guardrails:annotate', {
                codeBlocks: result.codeBlocks,
                duration: result.duration,
            })
        }

        return result.text
    }

    /**
     * Send transcript to view
     */
    private sendTranscript(): void {
        const chatTranscript = this.transcript.toChat()
        this.handleTranscript(chatTranscript, this.isMessageInProgress)
    }

    public isCustomRecipeAction(title: string): boolean {
        const customRecipeActions = ['add', 'get', 'menu']
        return customRecipeActions.includes(title)
    }

    public async executeCustomRecipe(title: string, type?: CodyPromptType): Promise<string | void> {
        if (!this.contextProvider.config.experimentalCustomRecipes) {
            return
        }
        // Send prompt names to display as recipe options
        if (!title || title === 'get') {
            await this.sendMyPrompts()
            return
        }
        // Create a new recipe
        if (title === 'menu') {
            await this.editor.controllers.prompt?.menu()
            await this.sendMyPrompts()
            return
        }
        if (title === 'add' && type) {
            try {
                // copy the cody.json file from the extension path and move it to the workspace root directory
                await this.editor.controllers.prompt?.addJSONFile(type)
            } catch (error) {
                void vscode.window.showErrorMessage(`Could not create a new cody.json file: ${error}`)
            }
            return
        }
        // Get prompt details from controller by title then execute prompt's command
        const promptText = this.editor.controllers.prompt?.find(title)
        await this.editor.controllers.prompt?.get('command')
        if (!promptText) {
            debug('executeCustomRecipe:noPrompt', title)
            return
        }
        await this.executeCommands(promptText, 'my-prompt')
        return promptText
    }

    protected async executeCommands(text: string, recipeID: RecipeID = 'chat-question'): Promise<void> {
        switch (true) {
            case /^\/o(pen)?/i.test(text) && this.editor.controllers.prompt !== undefined:
                // open the user's ~/.vscode/cody.json file
                await this.editor.controllers.prompt?.open(text.split(' ')[1])
                break
            case /^\/r(eset)?/i.test(text):
                await this.clearAndRestartSession()
                break
            case /^\/s(earch)?\s/i.test(text):
                await this.executeRecipe('context-search', text)
                break
            default:
                return this.executeRecipe(recipeID, text)
        }
    }

    /**
     * Send custom recipe names to view
     */
    private async sendMyPrompts(): Promise<void> {
        const send = async (): Promise<void> => {
            await this.editor.controllers.prompt?.refresh()
            const prompts = this.editor.controllers.prompt?.getPromptList() ?? []
            void this.handleMyPrompts(prompts, this.contextProvider.config.experimentalCustomRecipes)
        }
        this.editor.controllers.prompt?.setMessenger(send)
        await send()
    }

    private async saveTranscriptToChatHistory(): Promise<void> {
        if (this.transcript.isEmpty) {
            return
        }
        MessageProvider.chatHistory[this.currentChatID] = await this.transcript.toJSON()
        await this.saveChatHistory()
    }

    /**
     * Save chat history
     */
    private async saveChatHistory(): Promise<void> {
        const userHistory = {
            chat: MessageProvider.chatHistory,
            input: MessageProvider.inputHistory,
        }
        await this.localStorage.setChatHistory(userHistory)
    }

    /**
     * Delete history from current chat history and local storage
     */
    protected async deleteHistory(chatID: string): Promise<void> {
        delete MessageProvider.chatHistory[chatID]
        await this.localStorage.deleteChatHistory(chatID)
        this.sendHistory()
    }

    /**
     * Loads chat history from local storage
     */
    private loadChatHistory(): void {
        const localHistory = this.localStorage.getChatHistory()
        if (localHistory) {
            MessageProvider.chatHistory = localHistory?.chat
            MessageProvider.inputHistory = localHistory.input
        }
    }

    /**
     * Loads the most recent chat
     */
    private async loadRecentChat(): Promise<void> {
        const localHistory = this.localStorage.getChatHistory()
        if (localHistory) {
            const chats = localHistory.chat
            const sortedChats = Object.entries(chats).sort(
                (a, b) => +new Date(b[1].lastInteractionTimestamp) - +new Date(a[1].lastInteractionTimestamp)
            )
            const chatID = sortedChats[0][0]
            await this.restoreSession(chatID)
        }
    }

    /**
     * Send history to view
     */
    private sendHistory(): void {
        this.handleHistory({
            chat: MessageProvider.chatHistory,
            input: MessageProvider.inputHistory,
        })
    }

    /**
     * Send embedding connections or results error to output
     */
    private logEmbeddingsSearchErrors(): void {
        if (this.contextProvider.config.useContext !== 'embeddings') {
            return
        }
        const searchErrors = this.contextProvider.context.getEmbeddingSearchErrors()
        // Display error message as assistant response for users with indexed codebase but getting search errors
        if (this.contextProvider.context.checkEmbeddingsConnection() && searchErrors) {
            this.transcript.addErrorAsAssistantResponse(searchErrors)
            this.handleTranscriptErrors(true)
            debug('ChatViewProvider:onLogEmbeddingsErrors', '', { verbose: searchErrors })
        }
    }

    public transcriptForTesting(testing: TestSupport): ChatMessage[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        return this.transcript.toChat()
    }

    public fixupTasksForTesting(testing: TestSupport): FixupTask[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        if (!this.editor.controllers.fixups) {
            throw new Error('no fixup controller')
        }
        return this.editor.controllers.fixups.getTasks()
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposables = []
    }

    private get maxPromptTokens(): number {
        const authStatus = this.authProvider.getAuthStatus()

        const codyConfig = vscode.workspace.getConfiguration('cody')
        const tokenLimit = codyConfig.get<number>('provider.limit.prompt')
        const localSolutionLimit = codyConfig.get<number>('provider.limit.solution')

        // The local config takes precedence over the server config.
        if (tokenLimit && localSolutionLimit) {
            return tokenLimit - localSolutionLimit
        }

        const solutionLimit = (localSolutionLimit || ANSWER_TOKENS) + SAFETY_PROMPT_TOKENS

        if (authStatus.configOverwrites?.chatModelMaxTokens) {
            return authStatus.configOverwrites.chatModelMaxTokens - solutionLimit
        }

        return DEFAULT_MAX_TOKENS - solutionLimit
    }
}

function isAbortError(error: string): boolean {
    return error === 'aborted' || error === 'socket hang up'
}
