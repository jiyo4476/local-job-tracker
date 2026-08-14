import { render } from 'preact';
import '../styles.css';
import './app.css';
import { html } from '../../src/app/html';
import { App } from '../../src/app/App';

const root = document.getElementById('root');
if (root) {
  render(html`<${App} />`, root);
}
