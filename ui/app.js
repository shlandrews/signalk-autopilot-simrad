(() => {
  const BASE_PATH = '/plugins/signalk-simrad-autopilot';
  const STORAGE_KEY = 'signalk-simrad-autopilot-base-url';

  const serverInput = document.getElementById('serverBase');
  const statusEl = document.getElementById('status');
  const headingForm = document.getElementById('headingForm');
  const headingInput = document.getElementById('headingInput');
  const buttons = document.querySelectorAll('button[data-endpoint]');

  const defaultBase = window.location.origin || 'http://localhost:3000';

  function readStoredBase() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (_err) {
      return null;
    }
  }

  function writeStoredBase(value) {
    try {
      if (value) {
        window.localStorage.setItem(STORAGE_KEY, value);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (_err) {
      // ignore storage errors (e.g., disabled cookies)
    }
  }

  const storedBase = readStoredBase();
  serverInput.value = storedBase || defaultBase;

  function pluginBaseUrl() {
    const base = (serverInput.value || defaultBase).trim();
    if (!base) {
      return `${defaultBase}${BASE_PATH}`;
    }
    return `${base.replace(/\/$/, '')}${BASE_PATH}`;
  }

  function setStatus(message, isError = false) {
    if (typeof message === 'object') {
      statusEl.textContent = JSON.stringify(message, null, 2);
    } else {
      statusEl.textContent = message;
    }
    statusEl.classList.toggle('error', Boolean(isError));
  }

  async function post(endpoint, body) {
    const url = `${pluginBaseUrl()}${endpoint}`;
    const options = {
      method: 'POST',
      headers: {
        'Accept': 'application/json'
      }
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_err) {
        data = text;
      }

      if (!response.ok || (data && typeof data === 'object' && data.ok === false)) {
        const errorMessage =
          (data && data.error) || response.statusText || 'Request failed';
        throw new Error(errorMessage);
      }

      setStatus(data ?? { ok: true });
      if (data && typeof data === 'object' && typeof data.heading === 'number') {
        headingInput.value = Math.round(data.heading).toString().padStart(3, '0');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    }
  }

  buttons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const endpoint = button.dataset.endpoint;
      if (!endpoint) {
        return;
      }
      post(endpoint);
    });
  });

  headingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = headingInput.value.trim();
    if (!raw) {
      setStatus('Please enter a heading between 0 and 359 degrees.', true);
      return;
    }
    const heading = Number(raw);
    if (!Number.isFinite(heading) || heading < 0 || heading >= 360) {
      setStatus('Heading must be a number between 0 and 359.', true);
      return;
    }
    post('/setHeading', { heading });
  });

  serverInput.addEventListener('change', () => {
    const value = serverInput.value.trim();
    writeStoredBase(value);
  });

  setStatus('Ready.');
})();
