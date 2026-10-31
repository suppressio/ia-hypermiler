package usage

import (
	"encoding/json"
	"io"
	"time"
)

// SuccessDocument is shared by CLI output and future HTTP responses.
type SuccessDocument struct {
	SchemaVersion int        `json:"schemaVersion"`
	Provider      string     `json:"provider"`
	FetchedAt     string     `json:"fetchedAt"`
	Stale         bool       `json:"stale"`
	StaleReason   *StaleInfo `json:"staleReason,omitempty"`
	Usage         Usage      `json:"usage"`
}

// ErrorDocument omits the provider for command-line usage errors.
type ErrorDocument struct {
	SchemaVersion int    `json:"schemaVersion"`
	Provider      string `json:"provider,omitempty"`
	Error         *Error `json:"error"`
}

// WriteSuccess writes exactly one compact document followed by a newline.
func WriteSuccess(w io.Writer, provider string, u Usage, fetchedAt time.Time) error {
	return json.NewEncoder(w).Encode(SuccessDocument{
		SchemaVersion: SchemaVersion, Provider: provider,
		FetchedAt: fetchedAt.UTC().Format(time.RFC3339),
		Stale:     u.Stale != nil, StaleReason: u.Stale, Usage: u,
	})
}

// WriteError writes a provider error, or a usage error with an empty provider.
func WriteError(w io.Writer, provider string, err *Error) error {
	return json.NewEncoder(w).Encode(ErrorDocument{SchemaVersion, provider, err})
}
