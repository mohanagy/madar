package service

import (
	"example.com/madar-go-service/internal/audit"
	"example.com/madar-go-service/internal/repository"
)

type SessionService struct {
	repository *repository.SessionRepository
	audit      *audit.LoginAudit
}

func NewSessionService(repository *repository.SessionRepository, audit *audit.LoginAudit) *SessionService {
	return &SessionService{
		repository: repository,
		audit:      audit,
	}
}

func (s *SessionService) CreateLoginSession(userID string, deviceID string) repository.Session {
	session := s.repository.CreateLoginSession(userID, deviceID)
	s.audit.RecordLoginSession(userID, session.ID)
	return session
}
