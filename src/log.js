const debug = require('debug');

module.exports = (type, ...args) => {
  const types = {
    debug: debug('formio:debug'),
    info: debug('formio:info'),
    warning: debug('formio:warning'),
    error: debug('formio:error'),
  };

  // If type is not passed in.
  if (!types.hasOwnProperty(type)) {
    args.unshift(type);
    type = 'info';
  }

  types[types.hasOwnProperty(type) ? type : 'error'](...args);
};
