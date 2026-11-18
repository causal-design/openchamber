import { Window } from 'happy-dom';

// Happy DOM belongs to the UI workspace; the Vitest driver belongs to web.
export const createUpdateChecksWindow = () => new Window({ url: 'http://localhost' });
