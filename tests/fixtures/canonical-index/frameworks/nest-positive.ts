import { Controller, Get, Injectable, Module } from '@nestjs/common'

@Injectable()
export class UsersService {
  list(): string[] {
    return []
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  list(): string[] {
    return this.service.list()
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
