package handlers

import (
	"github.com/acme/go-semantic-fixture/internal/service"
	"github.com/gin-gonic/gin"
)

func (h *UserHandler) CreateUserMultiline(
	c *gin.Context,
)
{
	var svc *service.UserService
	svc = &service.UserService{}
	svc.Create("demo")
}
