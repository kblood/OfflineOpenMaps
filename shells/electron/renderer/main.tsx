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
