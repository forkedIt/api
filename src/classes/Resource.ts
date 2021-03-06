import {Router} from 'express';
import * as jsonpatch from 'fast-json-patch';
import * as moment from 'moment';
import {Model} from '../dbs/Model';
import {Api} from '../FormApi';

export class Resource {

  get name() {
    return this.model.name.toLowerCase();
  }

  get route() {
    return this.path(`/${this.name}`);
  }
  protected model: Model;
  protected router: Router;
  protected app: Api;

  constructor(model: Model, router: Router, app: Api) {
    this.model = model;
    this.router = router;
    this.app = app;

    this.rest();
  }

  public index(req, res, next) {
    this.app.log('debug', `resource index called for ${this.name}`);
    const query = this.indexQuery(req);
    const options = this.model.indexOptions(req.query);
    Promise.all([
      this.model.count(query, {}, req.context.params),
      this.model.find(query, options, req.context.params),
    ])
      .then(([count, docs]) => {
        res.resource = {
          count,
          items: docs.map((doc) => this.finalize(doc, req)),
        };
        this.app.log('debug', `resource index done for ${this.name}`);
        next();
      })
      .catch(next);
  }

  public post(req, res, next) {
    this.app.log('debug', `resource post called for ${this.name}`);
    this.model.create(this.prepare(req.body, req), req.context.params)
      .then((doc) => {
        res.resource = {
          item: this.finalize(doc, req),
        };
        this.app.log('debug', `resource post done for ${this.name}`);
        next();
      })
      .catch((err) => next(err));
  }

  public get(req, res, next) {
    this.app.log('debug', `resource get called for ${this.name}`);
    const query = this.getQuery(req, {});
    this.model.read(query, req.context.params)
      .then((doc) => {
        res.resource = {
          item: this.finalize(doc, req),
        };
        this.app.log('debug', `resource get done for ${this.name}`);
        next();
      })
      .catch(next);
  }

  public put(req, res, next) {
    this.app.log('debug', `resource put called for ${this.name}`);
    this.model.update(this.prepare(req.body, req), req.context.params)
      .then((doc) => {
        res.resource = {
          item: this.finalize(doc, req),
        };
        this.app.log('debug', `resource put done for ${this.name}`);
        next();
      })
      .catch(next);
  }

  public patch(req, res, next) {
    this.app.log('debug', `resource patch called for ${this.name}`);
    this.model.read({
      _id: this.model.toID(req.context.params[`${this.name}Id`]),
    }, req.context.params)
      .then((doc) => {
        const patched = jsonpatch.applyPatch(doc, req.body);
        this.model.update(this.prepare(patched.newDocument, req), req.context.params)
          .then((doc) => {
            res.resource = {
              item: this.finalize(doc, req),
            };
            this.app.log('debug', `resource patch done for ${this.name}`);
            next();
          });
      })
      .catch(next);
  }

  public delete(req, res, next) {
    this.app.log('debug', `resource delete called for ${this.name}`);
    this.model.delete({
      _id: this.model.toID(req.context.params[`${this.name}Id`]),
    }, req.context.params)
      .then((doc) => {
        res.resource = {
          item: this.finalize(doc, req),
        };
        this.app.log('debug', `resource delete done for ${this.name}`);
        next();
      })
      .catch(next);
  }

  // Return additions to the swagger specification.
  public swagger() {
    // TODO: Implement swagger
  }

  protected path(route) {
    return route;
  }

  /**
   * Call an array of promises in series and call next() when done.
   *
   * @param promises
   * @param next
   */
  protected callPromisesAsync(promises) {
    return promises.reduce((p, f) => p
        .then(f)
        .catch((err) => Promise.reject(err))
      , Promise.resolve());
  }

  protected rest() {
    this.app.log('debug', `registering rest endpoings for ${this.name}`);
    this.register('get', this.route, 'index');
    this.register('post', this.route, 'post');
    this.register('get', `${this.route}/:${this.name}Id`, 'get');
    this.register('put', `${this.route}/:${this.name}Id`, 'put');
    this.register('patch', `${this.route}/:${this.name}Id`, 'patch');
    this.register('delete', `${this.route}/:${this.name}Id`, 'delete');

    return this;
  }

  protected register(method, route, callback) {
    this.app.log('debug', `Registering route ${method.toUpperCase()}: ${route}`);
    this.router[method](route, (req, res, next) => {
      this[callback](req, res, next);
    });
  }

  protected getQuery(req, query: any = {}) {
    query._id = this.model.toID(req.context.params[`${this.name}Id`]);
    return query;
  }

  protected indexQuery(req, query: any = {}) {
    // @ts-ignore
    const { limit, skip, select, sort, populate, ...filters } = req.query || {};

    // Iterate through each filter.
    for (const key of Object.keys(filters)) {
      let value = filters[key];
      const [name, selector] = key.split('__');
      let parts;

      // See if this parameter is defined in our model.
      const param = this.model.schema[name.split('.')[0]];

      if (selector) {
        switch (selector) {
          case 'regex':
            // Set the regular expression for the filter.
            parts = value.match(/\/?([^/]+)\/?([^/]+)?/);

            try {
              value = new RegExp(parts[1], (parts[2] || 'i'));
            } catch (err) {
              value = null;
            }
            query[name] = value;
            break;
          case 'exists':
            value = ((value === 'true') || (value === '1')) ? true : value;
            value = ((value === 'false') || (value === '0')) ? false : value;
            value = !!value;
            query[name] = query[name] || {};
            query[name][`$${selector}`] = value;
            break;
          case 'in':
          case 'nin':
            value = Array.isArray(value) ? value : value.split(',');
            value = value.map((item) => {
              return this.indexQueryValue(name, item, param);
            });
            query[name] = query[name] || {};
            query[name][`$${selector}`] = value;
            break;
          default:
            value = this.indexQueryValue(name, value, param);
            query[name] = query[name] || {};
            query[name][`$${selector}`] = value;
            break;
        }
      } else {
        // Set the find query to this value.
        value = this.indexQueryValue(name, value, param);
        query[name] = value;
      }
    }

    return query;
  }

  protected indexQueryValue(name, value, param) {
    if (!param) {
      return value;
    }
    if (param.type === 'number') {
      return parseInt(value, 10);
    }

    const date = moment.utc(value, ['YYYY-MM-DD', 'YYYY-MM', moment.ISO_8601], true);
    if (date.isValid()) {
      return date.toDate();
    }

    // If this is an ID, and the value is a string, convert to an ObjectId.
    if (param.type === 'id') {
      try {
        value = this.model.toID(value);
      } catch (err) {
        this.app.log('warning', `Invalid ObjectID: ${value}`);
      }
    }

    return value;
  }

  protected prepare(item, req) {
    // Ensure they can't change the id.
    if (req.context.params[`${this.name}Id`]) {
      item._id = req.context.params[`${this.name}Id`];
    }

    // TODO: Fix this so only those with "create_own" can set or change the owner.
    if (!item.owner && req.user) {
      item.owner = req.user._id;
    }

    return item;
  }

  protected finalize(item, req: any = {}) {
    return item;
  }
}
