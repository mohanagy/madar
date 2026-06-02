package repository

type Session struct {
	ID       string `json:"session_id"`
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
}

type SessionRepository struct{}

func NewSessionRepository() *SessionRepository {
	return &SessionRepository{}
}

func (r *SessionRepository) CreateLoginSession(userID string, deviceID string) Session {
	return Session{
		ID:       userID + ":" + deviceID,
		UserID:   userID,
		DeviceID: deviceID,
	}
}
