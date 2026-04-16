export class GuardrailViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailViolation";
  }
}
