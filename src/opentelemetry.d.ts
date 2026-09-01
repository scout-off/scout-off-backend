declare module '@opentelemetry/api' {
  export interface Span {
    setAttribute(key: string, value: string | number | boolean): this;
    setAttributes(attributes: Record<string, string | number | boolean>): this;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): this;
    recordException(exception: Error, attributes?: Record<string, string | number | boolean>): this;
    end(): void;
    setStatus(status: { code: SpanStatusCode; message?: string }): this;
    isRecording(): boolean;
    spanContext(): SpanContext;
  }
  
  export enum SpanStatusCode {
    UNSET = 0,
    OK = 1,
    ERROR = 2,
  }
  
  export interface SpanContext {
    traceId: string;
    spanId: string;
    traceFlags: number;
  }
  
  export function isSpanContextValid(context: SpanContext): boolean;
  
  export interface Tracer {
    startSpan(name: string, options?: any): Span;
    startActiveSpan(name: string, fn: (span: Span) => void): any;
  }
  
  export interface Context {
    getValue(key: symbol): any;
  }
  
  export const trace: {
    getTracer(name: string, version?: string): Tracer;
    getActiveSpan(): Span | undefined;
    getSpan(context: Context): Span | undefined;
    setSpan(context: Context, span: Span): Context;
  };
  
  export const context: {
    active(): Context;
    with(target: Context, fn: () => void): any;
  };
  
  export const propagation: {
    inject(context: Context, carrier: any, setter: any): void;
    extract(context: Context, carrier: any, getter: any): Context;
  };
  
  export const diag: {
    setLogger(logger: any): void;
  };
  
  export interface TextMapGetter<T> {
    get(carrier: T, key: string): string | string[] | undefined;
    keys(carrier: T): string[];
  }
  
  export interface TextMapSetter<T> {
    set(carrier: T, key: string, value: string): void;
  }
}
