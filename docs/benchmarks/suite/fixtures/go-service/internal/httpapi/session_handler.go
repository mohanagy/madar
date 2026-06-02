package httpapi

import (
	"encoding/json"
	"net/http"

	"example.com/madar-go-service/internal/service"
)

type createLoginSessionRequest struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
}

type createLoginSessionResponse struct {
	SessionID  string `json:"session_id"`
	AuditEvent string `json:"audit_event"`
}

type SessionHandler struct {
	service *service.SessionService
}

func NewSessionHandler(service *service.SessionService) *SessionHandler {
	return &SessionHandler{service: service}
}

func (h *SessionHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/login/session", h.CreateLoginSession)
}

func (h *SessionHandler) CreateLoginSession(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload createLoginSessionRequest
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}

	session := h.service.CreateLoginSession(payload.UserID, payload.DeviceID)

	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(createLoginSessionResponse{
		SessionID:  session.ID,
		AuditEvent: "login_session_created",
	})
}
