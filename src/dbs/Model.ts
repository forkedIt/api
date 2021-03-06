import {Schema} from '../classes';
import {log} from '../log';
import {lodash as _} from '../util/lodash';
import {Database} from './Database';

export class Model {

  public get db() {
    return this._db;
  }

  public set db(db) {
    this._db = db;

    // Ensure the model is initialized before returning any calls.
    if (this._db) {
      this.initialized = this.initialize();
    } else {
      // this.initialized = Promise.reject('DB not initialized');
    }
  }

  public get name() {
    return this.schema.name;
  }

  public get collectionName() {
    return `${this.name}s`;
  }
  public schema: Schema;
  public initialized: Promise<any>;
  private _db: Database;

  constructor(schema: Schema, db: Database) {
    // @TODO
    // populate (deprecate?)
    // description (what does this do? - swagger)

    this.schema = schema;
    this.db = db;
  }

  /* Private Functions */

  public initialize() {
    return this.db.getCollections()
      .then((collections) => {
        if (collections.includes(this.collectionName)) {
          log('debug', `${this.collectionName} collection already exists`);
          return Promise.resolve();
        } else {
          log('debug', `${this.collectionName} collection doesn't exist. Creating...`);
          return this.db.createCollection(this.collectionName)
            .then(() => log('debug', `${this.collectionName} collection created successfully`))
            .catch((err) => log('error', err));
        }
      })
      .then(() => {
        const promises = [];
        for (const name of Object.keys(this.schema.schema)) {
          const field = this.schema.schema[name];
          if (field.index) {
            log('debug', `Ensuring index for ${this.collectionName}.${name}`);
            promises.push(this.db.createIndex(this.collectionName, name));
          }
        }
        if (this.schema.index) {
          this.schema.index.map((index) => {
            log('debug', `Ensure extra index for ${this.collectionName} ${index.name}`);
            promises.push(this.db.createIndex(this.collectionName, index.spec, index.options));
          });
        }
        return Promise.all(promises);
      });
  }

  public toID(value) {
    try {
      return this.db.toID(value);
    } catch (err) {
      return value;
    }
  }

  /** Public Functions */
  public indexOptions(query, options = {}) {
    const optionKeys = ['limit', 'skip', 'select', 'sort'];

    optionKeys.forEach((key) => {
      if (query.hasOwnProperty(key)) {
        switch (key) {
          case 'limit':
          case 'skip':
            options[key] = parseInt(query[key], 10);
            break;
          case 'sort':
          case 'select':
            // Select has changed to projection.
            options[(key === 'select' ? 'projection' : key)] = query[key].split(',')
              .map((item) => item.trim())
              .reduce((prev, item) => {
                let val = 1;
                if (item.charAt(0) === '-') {
                  item = item.substring(1);
                  val = -1;
                }
                prev[item] = val;
                return prev;
              }, {});
            break;
        }
      }
    });

    return options;
  }

  public find(query = {}, options = {}, context = {}): Promise<any> {
    return this.initialized.then(() => {
      return this.db.find(this.collectionName, query, options)
        .then((docs) => Promise.all(docs.map((doc) => this.afterLoad(doc))));
    });
  }

  public findOne(query = {}, options = {}, context = {}) {
    return this.find(query, context, options)
      .then((docs) => docs[0]);
  }

  public count(query = {}, options = {}, context = {}) {
    return this.initialized.then(() => {
      return this.db.count(this.collectionName, query, options);
    });
  }

  public create(input, context?) {
    return this.initialized.then(() => {
      return this.beforeSave(input, {})
        .then((doc) => {
          return this.db.create(this.collectionName, doc)
            .then((doc) => this.afterLoad(doc));
        });
    });
  }

  public read(query, context?) {
    return this.initialized.then(() => {
      return this.db.read(this.collectionName, query)
        .then((doc) => this.afterLoad(doc));
    });
  }

  public update(input, context?) {
    return this.initialized.then(() => {
      return this.read({ _id: this.toID(input._id) }, context).then((previous) => {
        return this.beforeSave(input, previous)
          .then((doc) => {
            return this.db.update(this.collectionName, doc, context)
              .then((doc) => this.afterLoad(doc));
          });
      });
    });
  }

  public delete(query, context?) {
    return this.initialized.then(() => {
      return this.db.delete(this.collectionName, query);
    });
  }

  protected iterateFields(path, schema, input, doc, execute) {
    const promises = [];
    if (Array.isArray(schema.type) && schema.type.length >= 1) {
      const values = _.get(input, path, []);
      values.forEach((value, index) => {
        if (typeof schema.type[0] === 'object') {
          for (const name of Object.keys(schema.type[0])) {
            promises.push(this.iterateFields(`${path}[${index}].${name}`, schema.type[0][name], input, doc, execute));
          }
        } else {
          const field = {
            ...schema,
            type: schema.type[0],
          };
          promises.push(this.iterateFields(`${path}[${index}]`, field, input, doc, execute));
        }
      });
    } else if (typeof schema.type === 'object') {
      for (const name of Object.keys(schema.type)) {
        promises.push(this.iterateFields(`${path}.${name}`, schema.type[name], input, doc, execute));
      }
    } else {
      promises.push(execute(path, schema, _.get(input, path), doc));
    }
    return Promise.all(promises).then(() => doc);
  }

  protected async beforeSave(input, doc) {
    input = await this.schema.preSave(input, this);

    // Ensure all fields are set first.
    await Promise.all(Object.keys(this.schema.schema).map((path) => {
      return this.iterateFields(path, this.schema.schema[path], input, doc, this.setField.bind(this));
    }));

    // Run validations.
    await Promise.all(Object.keys(this.schema.schema).map((path) => {
      return this.iterateFields(path, this.schema.schema[path], doc, doc, this.validateField.bind(this));
    }));

    return doc;
  }

  protected setField(path, field, value, doc) {
    return new Promise((resolve, reject) => {
      // Set default value
      if ((value === null || value === undefined) && field.hasOwnProperty('default')) {
        if (typeof field.default === 'function') {
          value = field.default();
        } else {
          value = field.default;
        }
      }

      // Check for read only
      if (field.readOnly) {
        value = _.get(doc, path, value);
      }

      // Use set function
      if (field.hasOwnProperty('set') && typeof field.set === 'function') {
        value = field.set(value);
      }

      // Check type
      if (value !== null && value !== undefined) {
        if (field.hasOwnProperty('type')) {
          switch (field.type) {
            case 'string':
              if (typeof value !== 'string') {
                value = value.toString();
              }
              break;
            case 'number':
              value = parseInt(value, 10);
              break;
            case 'boolean':
              value = !!value;
              break;
            case 'date':
              try {
                value = new Date(value);
              } catch (err) {
                if (!field.looseType) {
                  return reject(`'${path}' invalid type`);
                }
              }
              break;
            case 'id':
              try {
                value = this.toID(value);
              } catch (err) {
                if (!field.looseType) {
                  return reject(`'${path}' invalid type`);
                }
              }
              break;
            default:
              if (!(value instanceof field.type)) {
                try {
                  /* eslint-disable new-cap */
                  value = new field.type(value);
                  /* eslint-enable new-cap */
                } catch (err) {
                  if (!field.looseType) {
                    return reject(`'${path}' invalid type`);
                  }
                }
              }
          }
        }
      }

      // String options
      if (value && field.type === 'string') {
        if (field.lowercase) {
          value = value.toLowerCase();
        }
        if (field.trim) {
          value = value.trim();
        }
      }

      // Set the path on the doc
      if (value !== null && value !== undefined) {
        _.set(doc, path, value);
      }

      return resolve();
    });
  }

  protected validateField(path, field, value, doc) {
    return new Promise((resolve, reject) => {
      const promises = [];

      // Required
      if (!value && value !== 0 && field.required) {
        return reject(`'${path}' is required`);
      }

      // Enumarated values.
      if (value && field.hasOwnProperty('enum')) {
        if (!field.enum.includes(value)) {
          return reject(`Invalid enumerated option in '${path}'`);
        }
      }

      // Validate the value
      if (field.hasOwnProperty('validate') && Array.isArray(field.validate)) {
        field.validate.forEach((item) => {
          if (item.isAsync) {
            promises.push(new Promise((resolve) => {
              item.validator.call(doc, value, this, (result, message) =>
                resolve(result ? true : message || item.message));
            }));
          } else {
            if (!item.validator.call(doc, value, this)) {
              return reject(item.message);
            }
          }
        });
      }

      // Wait for async and check for errors.
      return Promise.all(promises).then((result) => {
        result = result.filter((item) => item !== true);
        if (result.length) {
          return reject(result[0]);
        }
        return resolve(doc);
      });
    });
  }

  protected afterLoad(doc) {
    if (!doc) {
      return Promise.resolve(doc);
    }
    const promises = [];
    for (const path of Object.keys(this.schema.schema)) {
      promises.push(this.iterateFields(path, this.schema.schema[path], doc, doc, this.getField.bind(this)));
    }
    return Promise.all(promises)
      .then(() => doc);
  }

  protected getField(path, field, value, doc) {
    // Use get function
    if (field.hasOwnProperty('get') && typeof field.set === 'function') {
      value = field.get(value);
    }

    // Change ids back to strings for simplicity
    if (field.type === 'id') {
      value = value ? value.toString() : value;
    }

    // Set the path on the doc
    if (value !== null && value !== undefined) {
      _.set(doc, path, value);
    }

    return Promise.resolve(doc);
  }
}
