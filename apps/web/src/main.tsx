import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './components/ui/ui.css';
import './components/layout/layout.css';
import './styles.css';
import './pages.css';

createRoot(document.getElementById('root')!).render(<App />);
