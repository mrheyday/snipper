/**
 * Structured logger for bot operations
 */
export class Logger {
  private prefix: string;
  private timestamp = true;

  constructor(name: string) {
    this.prefix = `[${name}]`;
  }

  private log(level: string, message: string, data?: unknown): void {
    const ts = this.timestamp ? `[${new Date().toISOString()}]` : '';
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`${ts} ${level} ${this.prefix} ${message}${dataStr}`);
  }

  info(message: string, data?: unknown): void {
    this.log('ℹ️ ', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('⚠️ ', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('❌', message, data);
  }

  success(message: string, data?: unknown): void {
    this.log('✅', message, data);
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      this.log('🐛', message, data);
    }
  }

  setTimestamp(enabled: boolean): void {
    this.timestamp = enabled;
  }
}

export default Logger;
