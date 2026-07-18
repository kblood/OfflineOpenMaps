import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
      console.warn('[openmaps] service worker registration failed:', error);
    });
  });
}
