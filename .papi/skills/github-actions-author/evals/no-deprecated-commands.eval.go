// Eval: no-deprecated-commands
//
// Rejects the deprecated stdout workflow commands ::set-output:: and ::set-env::
// anywhere in a workflow or composite action. GitHub disabled these for security
// (env injection); the modern replacements append to the $GITHUB_OUTPUT and
// $GITHUB_ENV files. Pure text scan across workflows and composite actions.
//
//	PASS (modern):                              FAIL (deprecated):
//	  - run: echo "k=v" >> "$GITHUB_OUTPUT"       - run: echo "::set-output name=k::v"
//	  - run: echo "K=v" >> "$GITHUB_ENV"          - run: echo "::set-env name=K::v"
//
// Score: 1.0 all clean, 0.6 majority, 0.2 mostly using deprecated commands, 0.5
// nothing to check, 0.0 skill not invoked. Failures name the matched command.
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

const evalID = "no-deprecated-commands"
const evalName = "No deprecated ::set-output:: / ::set-env:: commands"

var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

func isWorkflow(src string) bool {
	hasJobs := regexp.MustCompile(`(?m)^jobs\s*:`).MatchString(src)
	hasTrigger := regexp.MustCompile(`(?m)^(on|"on"|'on')\s*:`).MatchString(src)
	hasRunsOn := strings.Contains(src, "runs-on")
	return hasJobs && (hasTrigger || hasRunsOn)
}

var compositeRe = regexp.MustCompile(`(?m)^\s*using:\s*['"]?composite`)

func isComposite(src string) bool { return compositeRe.MatchString(src) }

func extractSourceBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if isWorkflow(src) || isComposite(src) {
			blocks = append(blocks, src)
		}
	}
	return blocks
}

func collectSourceFiles(workDir string) []string {
	if workDir == "" {
		return nil
	}
	sources := []string{}
	wfRoot := filepath.Join(workDir, ".github", "workflows")
	_ = filepath.Walk(workDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".yml" && ext != ".yaml" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		src := string(data)
		base := strings.ToLower(info.Name())
		inWorkflows := strings.HasPrefix(path, wfRoot)
		if inWorkflows || base == "action.yml" || base == "action.yaml" {
			if isWorkflow(src) || isComposite(src) {
				sources = append(sources, src)
			}
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

// deprecatedRe matches the deprecated stdout workflow commands, tolerating the
// optional leading/trailing colons GitHub used (e.g. `echo "::set-output ..."`).
var deprecatedRe = regexp.MustCompile(`::set-(output|env)\b`)

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

	sources := collectSourceFiles(ctx.WorkDir)
	fromDisk := len(sources)
	sources = append(sources, extractSourceBlocks(ctx.QualityTranscript)...)

	if len(sources) == 0 {
		emit(0.5, "No workflow or composite-action YAML found — nothing to check.")
		return
	}

	clean, total := 0, len(sources)
	firstViolation := ""
	for i, src := range sources {
		if match := deprecatedRe.FindString(src); match == "" {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("source %d uses deprecated %s (use $GITHUB_OUTPUT / $GITHUB_ENV)", i+1, match)
		}
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("No deprecated workflow commands across %d source(s) (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d source(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d source(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
