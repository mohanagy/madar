function Controller(_path: string): ClassDecorator {
  return () => undefined
}

@Controller('fake')
export class FakeController {}
