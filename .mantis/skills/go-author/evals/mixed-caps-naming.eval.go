package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

type scenario struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
}

type evalContext struct {
	Scenario          scenario `json:"scenario"`
	QualityTranscript string   `json:"qualityTranscript"`
	Invoked           bool     `json:"invoked"`
}

type evalResult struct {
	EvalID    string  `json:"evalId"`
	Name      string  `json:"name"`
	Score     float64 `json:"score"`
	Reasoning string  `json:"reasoning"`
}

const evalID = "mixed-caps-naming"
const evalName = "Multi-word names use MixedCaps not snake_case"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Unexported snake_case identifier: lower_word (two+ words with underscore)
	snakeCaseRe = regexp.MustCompile(`\b[a-z][a-z0-9]+_[a-z][a-z0-9_]+\b`)
	// Allow test helpers and build tags: Test_, Benchmark_, Example_, //go:build
	testIdentRe = regexp.MustCompile(`^(?:Test|Benchmark|Example)_`)
	// Allow well-known constants that are conventionally snake_case (none in Go, just in case)
	// Struct tags and import paths contain underscores but aren't identifiers
	tagRe = regexp.MustCompile("`[^`]*`")
	// String literals
	stringLitRe = regexp.MustCompile(`"[^"]*"`)
)

func extractCodeBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		blocks = append(blocks, m[1])
	}
	return blocks
}

func emit(score float64, reasoning string) {
	json.NewEncoder(os.Stdout).Encode(evalResult{
		EvalID:    evalID,
		Name:      evalName,
		Score:     score,
		Reasoning: reasoning,
	})
}

func main() {
	var ctx evalContext
	if err := json.NewDecoder(os.Stdin).Decode(&ctx); err != nil {
		os.Stderr.WriteString("decode: " + err.Error() + "\n")
		os.Exit(1)
	}

	if !ctx.Invoked || ctx.QualityTranscript == "" {
		emit(0.0, "Skipped — skill not invoked.")
		return
	}

	blocks := extractCodeBlocks(ctx.QualityTranscript)
	violations := []string{}
	seen := map[string]bool{}

	for _, block := range blocks {
		// Strip struct tags and string literals before scanning
		clean := tagRe.ReplaceAllString(block, "``")
		clean = stringLitRe.ReplaceAllString(clean, `""`)

		for _, match := range snakeCaseRe.FindAllString(clean, -1) {
			if testIdentRe.MatchString(match) {
				continue
			}
			if !seen[match] {
				violations = append(violations, match)
				seen[match] = true
			}
		}
	}

	if len(violations) == 0 {
		emit(1.0, "No snake_case identifiers found — naming uses MixedCaps as expected.")
		return
	}

	emit(0.1, "Go uses MixedCaps not snake_case (found: "+strings.Join(violations, ", ")+").")
}
