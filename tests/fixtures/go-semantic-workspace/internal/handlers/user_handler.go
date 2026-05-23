package handlers

import (
	"net/http"

	"github.com/acme/go-semantic-fixture/internal/service"
	"github.com/gin-gonic/gin"
)

type UserHandler struct{}

func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	var svc *service.UserService
	svc = &service.UserService{}
	svc.List()
}

func (h *UserHandler) CreateUser(c *gin.Context) {
	var svc *service.UserService
	svc = &service.UserService{}
	svc.Create("demo")
}
