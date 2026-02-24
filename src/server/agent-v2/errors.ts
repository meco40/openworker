export class AgentV2Error extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'UNAUTHORIZED'
      | 'INVALID_REQUEST'
      | 'BACKPRESSURE'
      | 'REPLAY_WINDOW_EXPIRED'
      | 'UNAVAILABLE',
  ) {
    super(message);
    this.name = 'AgentV2Error';
  }
}
