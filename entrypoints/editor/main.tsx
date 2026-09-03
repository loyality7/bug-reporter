import { createRoot } from 'react-dom/client';
import Editor from './Editor';
import '../popup/style.css';

createRoot(document.getElementById('root')!).render(<Editor />);
