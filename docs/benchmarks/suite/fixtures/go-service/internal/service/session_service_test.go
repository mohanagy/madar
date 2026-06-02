package service

import (
	"testing"

	"example.com/madar-go-service/internal/audit"
	"example.com/madar-go-service/internal/repository"
)

func TestCreateLoginSessionRecordsAuditEvidence(t *testing.T) {
	loginAudit := audit.NewLoginAudit()
	sessionService := NewSessionService(repository.NewSessionRepository(), loginAudit)

	session := sessionService.CreateLoginSession("u-123", "web")

	if session.ID != "u-123:web" {
		t.Fatalf("expected deterministic session id, got %q", session.ID)
	}
	if len(loginAudit.Events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(loginAudit.Events))
	}
}
