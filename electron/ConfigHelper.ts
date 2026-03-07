// ConfigHelper.ts
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import { EventEmitter } from "events"
import { OpenAI } from "openai"
import {
  type ApiProvider,
  type AppConfig,
  type ModelCategoryKey,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  TOGETHER_BASE_URL,
  getDefaultModel,
  isValidProvider,
  sanitizeModelSelection,
} from "../shared/aiConfig"
import { getBuiltInApiKey } from "./builtInApiKeys"

export class ConfigHelper extends EventEmitter {
  private configPath: string;
  private defaultConfig: AppConfig = {
    apiKey: "",
    apiProvider: DEFAULT_PROVIDER,
    extractionModel: DEFAULT_MODELS[DEFAULT_PROVIDER].extractionModel,
    solutionModel: DEFAULT_MODELS[DEFAULT_PROVIDER].solutionModel,
    debuggingModel: DEFAULT_MODELS[DEFAULT_PROVIDER].debuggingModel,
    language: "python",
    opacity: 1.0
  };

  constructor() {
    super();
    // Use the app's user data directory to store the config
    try {
      this.configPath = path.join(app.getPath('userData'), 'config.json');
      console.log('Config path:', this.configPath);
    } catch (err) {
      console.warn('Could not access user data path, using fallback');
      this.configPath = path.join(process.cwd(), 'config.json');
    }
    
    // Ensure the initial config file exists
    this.ensureConfigExists();
  }

  /**
   * Ensure config file exists
   */
  private ensureConfigExists(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.saveConfig(this.defaultConfig);
      }
    } catch (err) {
      console.error("Error ensuring config exists:", err);
    }
  }

  private detectProviderFromApiKey(
    apiKey: string,
    fallbackProvider: ApiProvider = DEFAULT_PROVIDER
  ): ApiProvider {
    const trimmedKey = apiKey.trim();

    if (trimmedKey.startsWith("sk-ant-")) {
      return "anthropic";
    }

    if (trimmedKey.startsWith("sk-")) {
      return "openai";
    }

    if (fallbackProvider === "together") {
      return "together";
    }

    return "gemini";
  }

  private getDefaultModelsForProvider(
    provider: ApiProvider
  ): Pick<AppConfig, ModelCategoryKey> {
    return {
      extractionModel: getDefaultModel(provider, "extractionModel"),
      solutionModel: getDefaultModel(provider, "solutionModel"),
      debuggingModel: getDefaultModel(provider, "debuggingModel"),
    };
  }

  private sanitizeModels(config: AppConfig): AppConfig {
    return {
      ...config,
      extractionModel: sanitizeModelSelection(
        config.apiProvider,
        "extractionModel",
        config.extractionModel
      ),
      solutionModel: sanitizeModelSelection(
        config.apiProvider,
        "solutionModel",
        config.solutionModel
      ),
      debuggingModel: sanitizeModelSelection(
        config.apiProvider,
        "debuggingModel",
        config.debuggingModel
      ),
    };
  }

  public loadConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const parsedConfig = JSON.parse(configData) as Partial<AppConfig> & {
          apiProvider?: string;
        };
        const provider = isValidProvider(parsedConfig.apiProvider || "")
          ? parsedConfig.apiProvider
          : DEFAULT_PROVIDER;

        return this.sanitizeModels({
          ...this.defaultConfig,
          ...parsedConfig,
          apiProvider: provider,
        });
      }
      
      // If no config exists, create a default one
      this.saveConfig(this.defaultConfig);
      return this.defaultConfig;
    } catch (err) {
      console.error("Error loading config:", err);
      return this.defaultConfig;
    }
  }

  public getConfiguredApiKey(provider?: ApiProvider): string {
    const config = this.loadConfig()
    const resolvedProvider = provider || config.apiProvider
    return getBuiltInApiKey(resolvedProvider)
  }

  public getPublicConfig(): AppConfig {
    return {
      ...this.loadConfig(),
      apiKey: ""
    }
  }

  /**
   * Save configuration to disk
   */
  public saveConfig(config: AppConfig): void {
    try {
      // Ensure the directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      // Write the config file
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("Error saving config:", err);
    }
  }

  /**
   * Update specific configuration values
   */
  public updateConfig(updates: Partial<AppConfig>): AppConfig {
    try {
      const { apiKey: _ignoredApiKey, ...configUpdates } = updates;
      const currentConfig = this.loadConfig();
      let provider: ApiProvider =
        configUpdates.apiProvider || currentConfig.apiProvider;
      
      // If provider is changing, reset models to the default for that provider
      if (
        configUpdates.apiProvider &&
        configUpdates.apiProvider !== currentConfig.apiProvider
      ) {
        const defaultModels = this.getDefaultModelsForProvider(
          configUpdates.apiProvider
        );
        configUpdates.extractionModel = defaultModels.extractionModel;
        configUpdates.solutionModel = defaultModels.solutionModel;
        configUpdates.debuggingModel = defaultModels.debuggingModel;
      }
      
      // Sanitize model selections in the updates
      if (configUpdates.extractionModel) {
        configUpdates.extractionModel = sanitizeModelSelection(
          provider,
          "extractionModel",
          configUpdates.extractionModel
        );
      }
      if (configUpdates.solutionModel) {
        configUpdates.solutionModel = sanitizeModelSelection(
          provider,
          "solutionModel",
          configUpdates.solutionModel
        );
      }
      if (configUpdates.debuggingModel) {
        configUpdates.debuggingModel = sanitizeModelSelection(
          provider,
          "debuggingModel",
          configUpdates.debuggingModel
        );
      }
      
      const newConfig = this.sanitizeModels({
        ...currentConfig,
        ...configUpdates,
        apiKey: "",
      });
      this.saveConfig(newConfig);
      
      // Only emit update event for changes other than opacity
      // This prevents re-initializing the AI client when only opacity changes
      if (
        configUpdates.apiProvider !== undefined ||
        configUpdates.extractionModel !== undefined ||
        configUpdates.solutionModel !== undefined ||
        configUpdates.debuggingModel !== undefined ||
        configUpdates.language !== undefined
      ) {
        this.emit('config-updated', newConfig);
      }
      
      return newConfig;
    } catch (error) {
      console.error('Error updating config:', error);
      return this.defaultConfig;
    }
  }

  /**
   * Check if the API key is configured
   */
  public hasApiKey(): boolean {
    return this.getConfiguredApiKey().length > 0
  }
  
  /**
   * Validate the API key format
   */
  public isValidApiKeyFormat(apiKey: string, provider?: ApiProvider): boolean {
    // If provider is not specified, attempt to auto-detect
    if (!provider) {
      provider = this.detectProviderFromApiKey(apiKey);
    }
    
    if (provider === "openai") {
      // Basic format validation for OpenAI API keys
      return /^sk-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    } else if (provider === "gemini") {
      // Basic format validation for Gemini API keys (usually alphanumeric with no specific prefix)
      return apiKey.trim().length >= 10; // Assuming Gemini keys are at least 10 chars
    } else if (provider === "anthropic") {
      // Basic format validation for Anthropic API keys
      return /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    } else if (provider === "together") {
      return apiKey.trim().length >= 20;
    }
    
    return false;
  }
  
  /**
   * Get the stored opacity value
   */
  public getOpacity(): number {
    const config = this.loadConfig();
    return config.opacity !== undefined ? config.opacity : 1.0;
  }

  /**
   * Set the window opacity value
   */
  public setOpacity(opacity: number): void {
    // Ensure opacity is between 0.1 and 1.0
    const validOpacity = Math.min(1.0, Math.max(0.1, opacity));
    this.updateConfig({ opacity: validOpacity });
  }  
  
  /**
   * Get the preferred programming language
   */
  public getLanguage(): string {
    const config = this.loadConfig();
    return config.language || "python";
  }

  /**
   * Set the preferred programming language
   */
  public setLanguage(language: string): void {
    this.updateConfig({ language });
  }
  
  /**
   * Test API key with the selected provider
   */
  public async testApiKey(
    apiKey: string,
    provider?: ApiProvider
  ): Promise<{valid: boolean, error?: string}> {
    // Auto-detect provider based on key format if not specified
    if (!provider) {
      provider = this.detectProviderFromApiKey(apiKey);
      console.log(
        `Using ${PROVIDER_DISPLAY_NAMES[provider]} API key format for testing`
      );
    }
    
    if (provider === "openai") {
      return this.testOpenAIKey(apiKey);
    } else if (provider === "gemini") {
      return this.testGeminiKey(apiKey);
    } else if (provider === "anthropic") {
      return this.testAnthropicKey(apiKey);
    } else if (provider === "together") {
      return this.testTogetherKey(apiKey);
    }
    
    return { valid: false, error: "Unknown API provider" };
  }
  
  /**
   * Test OpenAI API key
   */
  private async testOpenAIKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    return this.testOpenAICompatibleKey(apiKey, "openai");
  }

  /**
   * Test Together AI API key
   */
  private async testTogetherKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    return this.testOpenAICompatibleKey(apiKey, "together");
  }

  private async testOpenAICompatibleKey(
    apiKey: string,
    provider: "openai" | "together"
  ): Promise<{valid: boolean, error?: string}> {
    try {
      const openai = new OpenAI({
        apiKey,
        baseURL: provider === "together" ? TOGETHER_BASE_URL : undefined,
      });
      // Make a simple API call to test the key
      await openai.models.list();
      return { valid: true };
    } catch (error: unknown) {
      const providerName = PROVIDER_DISPLAY_NAMES[provider];
      console.error(`${providerName} API key test failed:`, error);
      
      // Determine the specific error type for better error messages
      let errorMessage = `Unknown error validating ${providerName} API key`;
      const status = typeof error === "object" && error && "status" in error
        ? (error as { status?: number }).status
        : undefined;
      const message = typeof error === "object" && error && "message" in error
        ? (error as { message?: string }).message
        : undefined;
      
      if (status === 401) {
        errorMessage = `Invalid API key. Please check your ${providerName} key and try again.`;
      } else if (status === 429) {
        errorMessage = `Rate limit exceeded. Your ${providerName} key has reached its request limit or has insufficient quota.`;
      } else if (status === 500) {
        errorMessage = `${providerName} server error. Please try again later.`;
      } else if (message) {
        errorMessage = `Error: ${message}`;
      }
      
      return { valid: false, error: errorMessage };
    }
  }
  
  /**
   * Test Gemini API key
   * Note: This is a simplified implementation since we don't have the actual Gemini client
   */
  private async testGeminiKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Gemini API and validate the key
      if (apiKey && apiKey.trim().length >= 20) {
        // Here you would actually validate the key with a Gemini API call
        return { valid: true };
      }
      return { valid: false, error: 'Invalid Gemini API key format.' };
    } catch (error: unknown) {
      console.error('Gemini API key test failed:', error);
      let errorMessage = 'Unknown error validating Gemini API key';
      
      if (typeof error === "object" && error && "message" in error) {
        errorMessage = `Error: ${(error as { message?: string }).message}`;
      }
      
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * Test Anthropic API key
   * Note: This is a simplified implementation since we don't have the actual Anthropic client
   */
  private async testAnthropicKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Anthropic API and validate the key
      if (apiKey && /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim())) {
        // Here you would actually validate the key with an Anthropic API call
        return { valid: true };
      }
      return { valid: false, error: 'Invalid Anthropic API key format.' };
    } catch (error: unknown) {
      console.error('Anthropic API key test failed:', error);
      let errorMessage = 'Unknown error validating Anthropic API key';
      
      if (typeof error === "object" && error && "message" in error) {
        errorMessage = `Error: ${(error as { message?: string }).message}`;
      }
      
      return { valid: false, error: errorMessage };
    }
  }
}

// Export a singleton instance
export const configHelper = new ConfigHelper();
