const MODEL_ALIAS: Record<string, string> = {
	"claude-fable-5-1": "fable 5.1",
	"claude-opus-5-5": "opus 5.5",
	"claude-sonnet-5-5": "sonnet 5.5",
	"claude-opus-4.8[1m]": "opus 4.8",
	"claude-opus-5[1m]": "opus 5",
	"claude-sonnet-5[1m]": "sonnet 5",
	"claude-lillypod-glm[1m]": "glm",
	"claude-lillypod-nemotron[1m]": "nemotron",
	"qwen3-8-27b-fp8": "qwen3 27b",
	"claude-haiku-4.5-20251001-v1": "haiku 4.5",
	"claude-opus-5-5[1m]": "opus 5.5",
	"claude-gpt-6-astra": "gpt6 astra",
	"claude-gpt-6-sol": "gpt6 sol",
	"claude-gpt-6-luna": "gpt6 luna",
};

/** Return the short display name for a model id, such as `sonnet 5.5`. */
export function modelAlias(id: string): string {
	return (
		MODEL_ALIAS[id] ??
		id
			.replace(/^claude-/, "")
			.replace(/\[1m\]$/, "")
			.replace(/-(\d+)-(\d+)/, " $1.$2")
	);
}
