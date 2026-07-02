// Eval: pin-external-uses
//
// Supply-chain hardening: every EXTERNAL action ref (`uses:`) must be pinned to a
// full 40-char commit SHA and carry a trailing `# version` comment (a mutable
// @v4/@main tag can be re-pointed at malicious code; a SHA cannot). Local refs
// (./ or ../) and docker:// refs are exempt — they don't pin to a commit SHA.
//
//	PASS:                                                     FAIL (tag):
//	  - uses: actions/checkout@b4ffde6...(40 hex) # v4.2.2      - uses: actions/checkout@v4
//	EXEMPT:                                                    FAIL (no comment):
//	  - uses: ./.github/actions/build                            - uses: actions/checkout@b4ffde6...(40 hex)
//	  - uses: docker://alpine:3.19
//
// Pure text parsing (comments aren't in yq's JSON output). Score: 1.0 all pinned,
// 0.6 majority, 0.2 mostly failing, 0.5 nothing to check, 0.0 skill not invoked.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	WorkDir           string   `json:"workDir"`
}

type evalResult struct {
	EvalID    string  `json:"evalId"`
	Name      string  `json:"name"`
	Score     float64 `json:"score"`
	Reasoning string  `json:"reasoning"`
}

const evalID = "pin-external-uses"
const evalName = "External uses are SHA-pinned with version comment"

// Matches ```yaml / ```yml / ``` fenced blocks and captures their body.
var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

// A block looks like a GitHub Actions workflow if it declares jobs plus a
// trigger or a runner — enough to avoid inspecting incidental YAML snippets.
func isWorkflow(src string) bool {
	hasJobs := regexp.MustCompile(`(?m)^jobs\s*:`).MatchString(src)
	hasTrigger := regexp.MustCompile(`(?m)^(on|"on"|'on')\s*:`).MatchString(src)
	hasRunsOn := strings.Contains(src, "runs-on")
	return hasJobs && (hasTrigger || hasRunsOn)
}

func extractWorkflowBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if isWorkflow(src) {
			blocks = append(blocks, src)
		}
	}
	return blocks
}

// collectWorkflowFiles finds workflow YAML written to disk under
// .github/workflows (the only path GitHub Actions actually reads).
func collectWorkflowFiles(workDir string) []string {
	if workDir == "" {
		return nil
	}
	root := filepath.Join(workDir, ".github", "workflows")
	sources := []string{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".yml" && ext != ".yaml" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr == nil {
			sources = append(sources, string(data))
		}
		return nil
	})
	return sources
}

func emit(score float64, reasoning string) {
	json.NewEncoder(os.Stdout).Encode(evalResult{
		EvalID:    evalID,
		Name:      evalName,
		Score:     score,
		Reasoning: reasoning,
	})
}

var (
	usesLineRe = regexp.MustCompile(`(?m)^\s*(?:-\s*)?uses:\s*(.+?)\s*$`)
	commentRe  = regexp.MustCompile(`\s+#`)
	shaRe      = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// isExempt reports whether a uses ref is local (same-repo) or a docker image,
// neither of which is pinned to a 40-char commit SHA.
func isExempt(ref string) bool {
	return strings.HasPrefix(ref, "./") ||
		strings.HasPrefix(ref, "../") ||
		strings.HasPrefix(ref, "docker://")
}

func trimQuotes(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// violations returns the unpinned/uncommented external uses in one workflow.
func violations(src string) []string {
	problems := []string{}
	for _, m := range usesLineRe.FindAllStringSubmatch(src, -1) {
		remainder := m[1]

		// Split the value from an optional trailing YAML comment (a '#'
		// preceded by whitespace).
		ref := remainder
		hasComment := false
		if loc := commentRe.FindStringIndex(remainder); loc != nil {
			ref = remainder[:loc[0]]
			comment := strings.TrimSpace(remainder[loc[1]:])
			hasComment = comment != ""
		}
		ref = trimQuotes(strings.TrimSpace(ref))

		if ref == "" || isExempt(ref) {
			continue
		}

		sha := ""
		if at := strings.LastIndex(ref, "@"); at >= 0 {
			sha = ref[at+1:]
		}
		if !shaRe.MatchString(sha) {
			problems = append(problems, fmt.Sprintf("'%s' not pinned to a 40-char SHA", ref))
			continue
		}
		if !hasComment {
			problems = append(problems, fmt.Sprintf("'%s' missing trailing version comment", ref))
		}
	}
	return problems
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

	// Prefer workflow files on disk; fall back to fenced blocks in the response.
	sources := collectWorkflowFiles(ctx.WorkDir)
	fromDisk := len(sources)
	sources = append(sources, extractWorkflowBlocks(ctx.QualityTranscript)...)

	if len(sources) == 0 {
		emit(0.5, "No GitHub Actions workflow YAML found — nothing to check.")
		return
	}

	clean, total := 0, len(sources)
	firstViolation := ""
	for i, src := range sources {
		if problems := violations(src); len(problems) == 0 {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("workflow %d: %s", i+1, problems[0])
		}
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("All external action refs across %d workflow(s) are SHA-pinned with a version comment (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
