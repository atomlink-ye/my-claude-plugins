import type { BridgeIdentity } from '../types/index.js';
import { DEFAULT_IDENTITY } from '../types/index.js';

export function getInjectedShimCode(wsPort: number, identity?: Partial<BridgeIdentity>): string {
  const providerName = identity?.name ?? DEFAULT_IDENTITY.name;
  const providerIcon = identity?.icon ?? DEFAULT_IDENTITY.icon;
  const providerRdns = identity?.rdns ?? DEFAULT_IDENTITY.rdns;

  return `(function () {
    var config = {
      wsUrl: ${JSON.stringify(`ws://127.0.0.1:${wsPort}`)}
    };
    var PROVIDER_NAME = ${JSON.stringify(providerName)};
    var PROVIDER_ICON = ${JSON.stringify(providerIcon)};
    var PROVIDER_RDNS = ${JSON.stringify(providerRdns)};

    var globalObject = typeof globalThis !== 'undefined' ? globalThis : window;
    var pending = new Map();
    var queuedMessages = [];
    var inflightIds = new Set();
    var listeners = new Map();
    var reconnectTimer = null;
    var reconnectDelay = 250;
    var requestCounter = 0;
    var ws = null;
    var connected = false;
    var destroyed = false;
    var currentAddress = null;
    var currentChainId = '0x1';
    var currentChainNumeric = '1';
    var initialStateReceived = false;
    var providerUuid = createUuid();
    var providerInfo = {
      uuid: providerUuid,
      name: PROVIDER_NAME,
      icon: PROVIDER_ICON,
      rdns: PROVIDER_RDNS
    };

    function createUuid() {
      if (globalObject.crypto && typeof globalObject.crypto.randomUUID === 'function') {
        return globalObject.crypto.randomUUID();
      }

      var template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
      return template.replace(/[xy]/g, function (char) {
        var randomValue = Math.floor(Math.random() * 16);
        var value = char === 'x' ? randomValue : ((randomValue & 0x3) | 0x8);
        return value.toString(16);
      });
    }

    function createError(code, message, data) {
      var error = new Error(message);
      error.code = code;
      if (typeof data !== 'undefined') {
        error.data = data;
      }
      return error;
    }

    function addListener(eventName, listener) {
      if (typeof listener !== 'function') {
        throw createError(-32602, 'Listener must be a function');
      }

      if (!listeners.has(eventName)) {
        listeners.set(eventName, new Set());
      }

      listeners.get(eventName).add(listener);
      return provider;
    }

    function removeListener(eventName, listener) {
      var handlers = listeners.get(eventName);
      if (handlers) {
        handlers.delete(listener);
        if (handlers.size === 0) {
          listeners.delete(eventName);
        }
      }
      return provider;
    }

    function emit(eventName, payload) {
      var handlers = listeners.get(eventName);
      if (!handlers) {
        return;
      }

      handlers.forEach(function (handler) {
        try {
          handler(payload);
        } catch (error) {
          setTimeout(function () {
            throw error;
          }, 0);
        }
      });
    }

    function isConnected() {
      return connected;
    }

    function nextRequestId() {
      requestCounter += 1;
      if (globalObject.crypto && typeof globalObject.crypto.randomUUID === 'function') {
        return globalObject.crypto.randomUUID();
      }
      return 'agent-wallet-' + Date.now() + '-' + requestCounter;
    }

    function normalizeParams(params) {
      if (typeof params === 'undefined' || params === null) {
        return [];
      }
      if (Array.isArray(params)) {
        return params;
      }
      return [params];
    }

    function sendRpc(method, params) {
      var id = nextRequestId();
      var message = {
        type: 'rpc_request',
        id: id,
        method: method,
        params: normalizeParams(params)
      };

      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject, message: message, sent: false });
        queuedMessages.push(message);
        flushQueue();
      });
    }

    function flushQueue() {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      while (queuedMessages.length > 0) {
        var message = queuedMessages.shift();
        var request = pending.get(message.id);
        if (!request) {
          continue;
        }

        try {
          ws.send(JSON.stringify(message));
          request.sent = true;
          inflightIds.add(message.id);
        } catch (error) {
          queuedMessages.unshift(message);
          break;
        }
      }
    }

    function rejectInflight(error) {
      inflightIds.forEach(function (id) {
        var request = pending.get(id);
        if (!request) {
          return;
        }
        pending.delete(id);
        request.reject(error);
      });
      inflightIds.clear();
    }

    function scheduleReconnect() {
      if (destroyed || reconnectTimer !== null) {
        return;
      }

      reconnectTimer = globalObject.setTimeout(function () {
        reconnectTimer = null;
        connectWebSocket();
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    }

    function applyState(address, chainIdHex) {
      var nextAddress = typeof address === 'string' ? address.toLowerCase() : null;
      var nextChainHex = typeof chainIdHex === 'string' ? chainIdHex : currentChainId;

      var addressChanged = nextAddress !== currentAddress;
      var chainChanged = nextChainHex !== currentChainId;

      currentAddress = nextAddress;
      if (chainChanged) {
        currentChainId = nextChainHex;
        try {
          currentChainNumeric = String(parseInt(nextChainHex, 16));
        } catch (_error) {
          currentChainNumeric = nextChainHex;
        }
      }

      if (chainChanged) {
        emit('chainChanged', currentChainId);
      }
      if (addressChanged || !initialStateReceived) {
        emit('accountsChanged', currentAddress ? [currentAddress] : []);
      }

      initialStateReceived = true;
    }

    function updateIdentity(identity) {
      providerUuid = createUuid();
      providerInfo = {
        uuid: providerUuid,
        name: identity && typeof identity.name === 'string' ? identity.name : PROVIDER_NAME,
        icon: identity && typeof identity.icon === 'string' ? identity.icon : PROVIDER_ICON,
        rdns: identity && typeof identity.rdns === 'string' ? identity.rdns : PROVIDER_RDNS
      };
    }

    function handleDaemonMessage(event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (_error) {
        return;
      }

      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'event') {
        if (message.event === 'state') {
          applyState(message.address, message.chainIdHex);
          return;
        }
        if (message.event === 'accountsChanged') {
          var accounts = Array.isArray(message.accounts) ? message.accounts : [];
          applyState(accounts[0] || null, currentChainId);
          return;
        }
        if (message.event === 'chainChanged') {
          applyState(currentAddress, message.chainIdHex);
          return;
        }
        if (message.event === 'identityChanged') {
          updateIdentity(message.identity);
          announceProvider();
          return;
        }
        return;
      }

      if (message.type !== 'rpc_response' || typeof message.id !== 'string') {
        return;
      }

      var request = pending.get(message.id);
      if (!request) {
        return;
      }

      pending.delete(message.id);
      inflightIds.delete(message.id);

      if (message.error) {
        request.reject(createError(message.error.code, message.error.message));
        return;
      }

      request.resolve(message.result);
    }

    function connectWebSocket() {
      if (destroyed) {
        return;
      }

      try {
        ws = new WebSocket(config.wsUrl);
      } catch (_error) {
        scheduleReconnect();
        return;
      }

      ws.addEventListener('open', function () {
        connected = true;
        reconnectDelay = 250;
        emit('connect', { chainId: currentChainId });
        flushQueue();
      });

      ws.addEventListener('message', handleDaemonMessage);

      ws.addEventListener('close', function () {
        var wasConnected = connected;
        connected = false;
        ws = null;
        rejectInflight(createError(4900, 'Wallet disconnected from bridge daemon'));
        if (wasConnected) {
          emit('disconnect', { code: 4900, message: 'Wallet disconnected from bridge daemon' });
        }
        scheduleReconnect();
      });

      ws.addEventListener('error', function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
          return;
        }
        connected = false;
      });
    }

    function announceProvider() {
      globalObject.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: providerInfo,
          provider: provider
        }
      }));
    }

    function handleSwitchChain(params) {
      var chain = params && params[0];
      if (!chain || typeof chain !== 'object' || typeof chain.chainId !== 'string') {
        throw createError(-32602, 'wallet_switchEthereumChain requires a chainId parameter');
      }

      // Only allow switching to the current chain
      if (chain.chainId.toLowerCase() !== currentChainId.toLowerCase()) {
        throw createError(4902, 'Unrecognized chain ID "' + chain.chainId + '". Only chain ' + currentChainId + ' is supported.');
      }

      return null;
    }

    function request(requestArguments) {
      if (!requestArguments || typeof requestArguments !== 'object') {
        return Promise.reject(createError(-32602, 'Invalid request arguments'));
      }

      var method = requestArguments.method;
      var params = normalizeParams(requestArguments.params);

      if (typeof method !== 'string' || method.length === 0) {
        return Promise.reject(createError(-32602, 'Invalid request method'));
      }

      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return Promise.resolve(currentAddress ? [currentAddress] : []);
      }

      if (method === 'eth_chainId') {
        return Promise.resolve(currentChainId);
      }

      if (method === 'wallet_switchEthereumChain') {
        try {
          return Promise.resolve(handleSwitchChain(params));
        } catch (error) {
          return Promise.reject(error);
        }
      }

      return sendRpc(method, params);
    }

    function send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return request({ method: methodOrPayload, params: normalizeParams(paramsOrCallback) });
      }

      if (!methodOrPayload || typeof methodOrPayload !== 'object') {
        throw createError(-32602, 'Invalid send payload');
      }

      return request(methodOrPayload);
    }

    function sendAsync(payload, callback) {
      if (typeof callback !== 'function') {
        throw createError(-32602, 'Callback is required for sendAsync');
      }

      request(payload).then(function (result) {
        callback(null, {
          id: payload && payload.id,
          jsonrpc: '2.0',
          result: result
        });
      }).catch(function (error) {
        callback(error, null);
      });
    }

    var providerTarget = {
      request: request,
      send: send,
      sendAsync: sendAsync,
      on: addListener,
      addListener: addListener,
      removeListener: removeListener,
      off: removeListener,
      removeAllListeners: function (eventName) {
        if (typeof eventName === 'string') {
          listeners.delete(eventName);
        } else {
          listeners.clear();
        }
        return provider;
      },
      once: function (eventName, listener) {
        function onceListener(payload) {
          removeListener(eventName, onceListener);
          listener(payload);
        }
        return addListener(eventName, onceListener);
      },
      enable: function () {
        return request({ method: 'eth_requestAccounts' });
      },
      isConnected: isConnected,
      _metamask: {
        isUnlocked: function () {
          return Promise.resolve(true);
        }
      }
    };

    var provider = new Proxy(providerTarget, {
      get: function (target, property, receiver) {
        if (property === 'isMetaMask') {
          return true;
        }
        if (property === 'selectedAddress') {
          return currentAddress;
        }
        if (property === 'chainId') {
          return currentChainId;
        }
        if (property === 'networkVersion') {
          return currentChainNumeric;
        }
        if (property === 'providers') {
          return [receiver];
        }
        if (property === Symbol.toStringTag) {
          return 'EthereumProvider';
        }
        return Reflect.get(target, property, receiver);
      },
      has: function (target, property) {
        return property === 'isMetaMask'
          || property === 'selectedAddress'
          || property === 'chainId'
          || property === 'networkVersion'
          || property === 'providers'
          || Reflect.has(target, property);
      },
      ownKeys: function (target) {
        var keys = Reflect.ownKeys(target);
        keys.push('isMetaMask', 'selectedAddress', 'chainId', 'networkVersion', 'providers');
        return Array.from(new Set(keys));
      },
      getOwnPropertyDescriptor: function (target, property) {
        if (property === 'isMetaMask' || property === 'selectedAddress' || property === 'chainId' || property === 'networkVersion' || property === 'providers') {
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: provider[property]
          };
        }
        return Object.getOwnPropertyDescriptor(target, property);
      },
      set: function (target, property, value, receiver) {
        return Reflect.set(target, property, value, receiver);
      }
    });

    Object.defineProperty(globalObject, 'ethereum', {
      configurable: true,
      enumerable: true,
      get: function () {
        return provider;
      },
      set: function () {
        return true;
      }
    });

    globalObject.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();
    connectWebSocket();
  })();`;
}
