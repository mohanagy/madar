package service

import "github.com/acme/go-semantic-fixture/internal/repository"

type UserService struct{}

func (s *UserService) List() {}

func (s *UserService) Create(name string) {
	s.validate(name)

	var repo *repository.UserRepository
	repo = &repository.UserRepository{}
	repo.Insert(name)
}
