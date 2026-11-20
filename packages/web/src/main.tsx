import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/App.tsx';
import { AppStore } from './app/store.ts';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const store = new AppStore();
createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
void store.start();
