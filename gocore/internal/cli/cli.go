// Package cli dispatches the binary's subcommands.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"

	"github.com/suppressio/ia-hypermiler/gocore/internal/buildinfo"
	"github.com/suppressio/ia-hypermiler/gocore/internal/logging"
)

const (
	// ExitOK indicates successful command execution.
	ExitOK = 0
	// ExitProviderError is reserved for provider failures in the usage command (#26).
	ExitProviderError = 1
	// ExitUsage indicates invalid command-line arguments.
	ExitUsage = 2
)

// Run executes a subcommand, keeping command output on stdout and logs on stderr.
func Run(args []string, _ io.Reader, stdout, stderr io.Writer) int {
	logger := logging.New(stderr)
	logger.Debug("Starting CLI", "version", buildinfo.Version)

	if len(args) == 0 {
		printUsage(stderr)
		return ExitUsage
	}

	command := args[0]
	switch command {
	case "help", "-h", "--help", "version":
	default:
		printUsage(stderr)
		return ExitUsage
	}

	flags := flag.NewFlagSet(buildinfo.Name+" "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {}
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printUsage(stdout)
			return ExitOK
		}
		printUsage(stderr)
		return ExitUsage
	}
	if flags.NArg() != 0 {
		printUsage(stderr)
		return ExitUsage
	}

	switch command {
	case "version":
		_, _ = fmt.Fprintf(stdout, "%s %s (%s/%s)\n", buildinfo.Name, buildinfo.Version, runtime.GOOS, runtime.GOARCH)
	default:
		printUsage(stdout)
	}
	return ExitOK
}

func printUsage(w io.Writer) {
	_, _ = fmt.Fprintf(w, "Usage: %s <command>\n\nCommands:\n  version  Print version and platform\n  help     Show this help\n", buildinfo.Name)
}
