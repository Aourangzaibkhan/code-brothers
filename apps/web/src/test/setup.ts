import '@testing-library/jest-dom/vitest';

// jsdom lacks ResizeObserver, which @xyflow/react requires.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

// @xyflow/system reads DOMMatrixReadOnly when computing transforms.
class DOMMatrixReadOnlyStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m11 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m22 = 1;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m33 = 1;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  m44 = 1;
  is2D = true;
  isIdentity = true;
  constructor(_init?: string | number[]) {}
  multiply(): DOMMatrixReadOnlyStub {
    return new DOMMatrixReadOnlyStub();
  }
  translate(): DOMMatrixReadOnlyStub {
    return new DOMMatrixReadOnlyStub();
  }
  scale(): DOMMatrixReadOnlyStub {
    return new DOMMatrixReadOnlyStub();
  }
}
(globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
