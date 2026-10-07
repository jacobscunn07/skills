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

const evalID = "no-get-prefix"
const evalName = "Getter methods omit Get prefix"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Exported method on a receiver that starts with Get: func (x *T) GetFoo()
	getMethodRe = regexp.MustCompile(`\bfunc\s*\(\s*\w+\s+\*?\w+\s*\)\s*(Get[A-Z]\w*)\s*\(`)
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

	allCode := strings.Join(extractCodeBlocks(ctx.QualityTranscript), "\n")
	matches := getMethodRe.FindAllStringSubmatch(allCode, -1)

	if len(matches) == 0 {
		emit(1.0, "No Get-prefixed getter methods found.")
		return
	}

	names := make([]string, 0, len(matches))
	for _, m := range matches {
		names = append(names, m[1])
	}
	emit(0.1, "Getter methods should omit the Get prefix (found: "+strings.Join(names, ", ")+"). Use Owner() not GetOwner().")
}
