import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// @testing-library/jest-dom is not installed, so only DOM cleanup is registered.
afterEach(() => {
  cleanup();
});
