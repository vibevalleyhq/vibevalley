package ai

import "os"

var envKeys = map[string]string{
	"anthropic":  "ANTHROPIC_API_KEY",
	"deepseek":   "DEEPSEEK_API_KEY",
	"openai":     "OPENAI_API_KEY",
	"moonshotai": "MOONSHOT_API_KEY",
	"openrouter": "OPENROUTER_API_KEY",
	"zai":        "ZAI_API_KEY",
}

func GetEnvApiKey(provider string) string {
	name, ok := envKeys[provider]
	if !ok {
		return ""
	}
	return os.Getenv(name)
}
