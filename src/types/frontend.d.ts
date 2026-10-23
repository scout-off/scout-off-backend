/**
 * Ambient type definitions for frontend React components
 * in repositories where @types/react is provided externally.
 */

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
  // Kept as an (empty) interface rather than a type alias so consumers can
  // declaration-merge into JSX.Element.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Element extends Record<string, any> {}
}

declare module 'react' {
  export type ReactNode =
    | string
    | number
    | boolean
    | null
    | undefined
    | JSX.Element
    | Iterable<ReactNode>
    | ReactNode[];

  export type ReactElement = JSX.Element;

  export interface FC<P = object> {
    (props: P, context?: any): ReactElement | null;
    displayName?: string;
  }

  export function useState<T>(
    initialState: T | (() => T),
  ): [T, (value: T | ((prev: T) => T)) => void];

  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly any[],
  ): void;

  export function useCallback<T extends (...args: any[]) => any>(
    callback: T,
    deps: readonly any[],
  ): T;

  export function useRef<T>(initialValue: T): { current: T };

  export function useMemo<T>(factory: () => T, deps: readonly any[] | undefined): T;

  export function createElement(
    type: any,
    props?: any,
    ...children: any[]
  ): ReactElement;

  export interface CSSProperties {
    [key: string]: any;
  }

  export interface MouseEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
    target: T;
  }

  export interface ChangeEvent<T = Element> {
    target: T;
  }

  const React: {
    createElement: typeof createElement;
    useState: typeof useState;
    useEffect: typeof useEffect;
    useCallback: typeof useCallback;
    useRef: typeof useRef;
    useMemo: typeof useMemo;
  };

  export default React;
}
