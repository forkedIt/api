import {lodash as _} from '../../../util/lodash';

export const datetime = (component, data, handler, action) => {
  if (['put', 'post', 'patch'].includes(action) && ['afterValidation'].includes(handler)) {
    const value = _.get(data, component.key);
    if (value) {
      _.set(data, component.key, new Date(value));
    }
  }
  return Promise.resolve();
};
