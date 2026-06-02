# Go service benchmark fixture

This fixture is a small `net/http` login session service used by the public benchmark suite.

Primary flow:

- `cmd/api/main.go` wires the HTTP route
- `internal/httpapi/session_handler.go` decodes the request and calls the service
- `internal/service/session_service.go` creates the session and records audit evidence
- `internal/repository/session_repository.go` persists the session-shaped record
- `internal/audit/login_audit.go` captures the login-session audit event

The suite prompts for this fixture focus on explain, implement, review, and impact questions around the same bounded session-creation path.
