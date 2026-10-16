package ai

import "os"

// API keys from the environment.

// envKeys is where a provider's key is found when none is given.
var envKeys = map[string]string{
	"anthropic":  "ANTHROPIC_API_KEY",
	"deepseek":   "DEEPSEEK_API_KEY",
	"openai":     "OPENAI_API_KEY",
	"moonshotai": "MOONSHOT_API_KEY",
	"openrouter": "OPENROUTER_API_KEY",
	"zai":        "ZAI_API_KEY",
}

// GetEnvApiKey is the provider's key from the environment; "" when there is none.
func GetEnvApiKey(provider string) string {
	name, ok := envKeys[provider]
	if !ok {
		return ""
	}
	return os.Getenv(name)
}
