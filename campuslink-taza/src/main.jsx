import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AppProvider} from './context';
import App from './App';
import {InstallAppProvider} from './components/InstallApp';
import {registerInstallWorker} from './lib/install';
import './styles.css';

// Text fields also match :focus-visible after a mouse click in many browsers.
// Track navigation so focus indicators stay useful for keyboard users.
document.documentElement.dataset.inputModality = 'pointer';
document.addEventListener('pointerdown', () => {
  document.documentElement.dataset.inputModality = 'pointer';
}, true);
document.addEventListener('keydown', event => {
  const element = event.target;
  const textEntry = element instanceof HTMLElement && (
    element.isContentEditable || element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(element.type))
  );
  if (event.key === 'Tab' || event.key === 'Escape' || (!textEntry && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(event.key))) {
    document.documentElement.dataset.inputModality = 'keyboard';
  }
}, true);

registerInstallWorker();
// URL-backed controls must update with typing and clicks, before another
// interaction or native Back can overtake a deferred router transition.
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter useTransitions={false}><AppProvider><InstallAppProvider><App/></InstallAppProvider></AppProvider></BrowserRouter></React.StrictMode>);
