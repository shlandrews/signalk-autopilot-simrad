(() => {
  const PLUGIN_ID = 'signalk-autopilot-simrad';
  const BASE_PATH = `/plugins/${PLUGIN_ID}`;
  const STORAGE_KEY = `${PLUGIN_ID}-base-url`;
  const TOKEN_STORAGE_KEY = `${PLUGIN_ID}-auth-token`;
  const CREDS_STORAGE_KEY = `${PLUGIN_ID}-use-credentials`;

  const serverInput = document.getElementById('serverBase');
  const tokenInput = document.getElementById('tokenInput');
  const credentialsCheckbox = document.getElementById('useCredentials');
  const statusEl = document.getElementById('status');
  const headingForm = document.getElementById('headingForm');
  const headingInput = document.getElementById('headingInput');
  const buttons = document.querySelectorAll('button[data-endpoint]');

  const defaultBase = window.location.origin || 'http://localhost:3000';


  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      if (value !== undefined && value !== null && value !== '') {
        window.localStorage.setItem(key, value);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch (_err) {
      // ignore storage errors (e.g., disabled cookies)
    }
  }

  function writeStoredBoolean(key, value) {
    writeStored(key, value ? 'true' : '');
  }

  const storedBase = readStored(STORAGE_KEY);
  if (serverInput) {
    serverInput.value = storedBase || defaultBase;
  }

  const storedToken = readStored(TOKEN_STORAGE_KEY);
  if (tokenInput && typeof storedToken === 'string') {
    tokenInput.value = storedToken;
  }

  const storedCreds = readStored(CREDS_STORAGE_KEY);
  if (credentialsCheckbox) {
    credentialsCheckbox.checked = storedCreds === 'true';
  }

  function pluginBaseUrl() {
    const base = (serverInput && serverInput.value ? serverInput.value : defaultBase).trim();
   
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
    const token = tokenInput ? tokenInput.value.trim() : '';
    const useCredentials = Boolean(credentialsCheckbox && credentialsCheckbox.checked) && !token;
    const options = {
      method: 'POST',
      headers: {
        'Accept': 'application/json'
      },
      credentials: useCredentials ? 'include' : 'omit'
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

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
      setStatus(`Error calling ${url}: ${err.message}`, true);
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

  if (serverInput) {
    serverInput.addEventListener('change', () => {
      const value = serverInput.value.trim();
      writeStored(STORAGE_KEY, value);
    });
  }

  if (tokenInput) {
    tokenInput.addEventListener('change', () => {
      const value = tokenInput.value.trim();
      writeStored(TOKEN_STORAGE_KEY, value);
      if (value) {
        setStatus('Bearer token saved. All requests will include Authorization headers.');
      } else {
        setStatus('Bearer token cleared.');
      }
    });
  }

  if (credentialsCheckbox) {
    credentialsCheckbox.addEventListener('change', () => {
      writeStoredBoolean(CREDS_STORAGE_KEY, credentialsCheckbox.checked);
      if (credentialsCheckbox.checked && tokenInput && tokenInput.value.trim()) {
        setStatus('Browser credentials enabled, but bearer token remains active and takes precedence.');
      } else if (credentialsCheckbox.checked) {
        setStatus('Browser credentials enabled. Ensure you are logged in to the Signal K admin UI.');
      } else {
        setStatus('Browser credentials disabled; requests will omit cookies.');
      }
    });
  }


  setStatus('Ready.');
})();
