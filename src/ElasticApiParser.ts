/* eslint-disable no-param-reassign */
/// <reference path="./types.d.ts" />

import dox from 'dox';
import fs from 'fs';
import path from 'path';
import {
  upperFirst,
  ObjectTypeComposer,
  EnumTypeComposer,
  ObjectTypeComposerArgumentConfigDefinition,
  ObjectTypeComposerFieldConfigMapDefinition,
  ObjectTypeComposerArgumentConfigAsObjectDefinition,
  ObjectTypeComposerFieldConfigAsObjectDefinition,
} from 'graphql-compose';
import { reorderKeys } from './utils';

export type ElasticParamConfigT = {
  type: string;
  name?: string;
  options?: any;
  default?: any;
};

export type ElasticCaSettingsUrlT = {
  fmt: string;
  req: {
    [name: string]: ElasticParamConfigT;
  };
};

export type ElasticCaSettingsT = {
  params: {
    [name: string]: ElasticParamConfigT;
  };
  url?: ElasticCaSettingsUrlT;
  urls?: ElasticCaSettingsUrlT[];
  needBody?: true;
  method?: string;
};

export type ElasticParsedArgsDescriptionsT = {
  [argName: string]: string | undefined;
};

export type ElasticParsedSourceT = {
  [dottedMethodName: string]: {
    elasticMethod: string | string[];
    description: string | undefined;
    argsSettings: ElasticCaSettingsT | undefined;
    argsDescriptions: ElasticParsedArgsDescriptionsT;
  };
};

export type ElasticApiParserOptsT = {
  elasticClient?: any; // Elastic client
  apiVersion?: string;
  prefix?: string;
  elasticApiFilePath?: string;
};

export default class ElasticApiParser {
  cachedEnums: {
    [fieldName: string]: { [stringifiedValues: string]: EnumTypeComposer<any> };
  };

  apiVersion: string;
  prefix: string;
  elasticClient: any;
  parsedSource: ElasticParsedSourceT;

  constructor(opts: ElasticApiParserOptsT = {}) {
    // available versions can be found in installed package `elasticsearch`
    // in file /node_modules/elasticsearch/src/lib/apis/index.js
    this.apiVersion =
      opts.apiVersion ||
      (opts.elasticClient &&
        opts.elasticClient.transport &&
        opts.elasticClient.transport._config &&
        opts.elasticClient.transport._config.apiVersion) ||
      '_default';
    const apiFilePath = path.resolve(
      opts.elasticApiFilePath || ElasticApiParser.findApiVersionFile(this.apiVersion)
    );
    const source = ElasticApiParser.loadApiFile(apiFilePath);
    this.parsedSource = ElasticApiParser.parseSource(source);

    this.elasticClient = opts.elasticClient;
    this.prefix = opts.prefix || 'Elastic';
    this.cachedEnums = {};
  }

  static loadFile(absolutePath: string): string {
    return fs.readFileSync(absolutePath, 'utf8');
  }

  static loadApiFile(absolutePath: string): string {
    let code;
    try {
      code = ElasticApiParser.loadFile(absolutePath);
    } catch (e) {
      throw new Error(`Cannot load Elastic API source file from ${absolutePath}`);
    }
    return ElasticApiParser.cleanUpSource(code);
  }

  static loadApiListFile(absolutePath: string): string {
    let code;
    try {
      code = ElasticApiParser.loadFile(absolutePath);
    } catch (e) {
      throw new Error(`Cannot load Elastic API file with available versions from ${absolutePath}`);
    }
    return code;
  }

  static findApiVersionFile(version: string): string {
    const esModulePath = path.dirname(require.resolve('elasticsearch'));
    const apiFolder = `${esModulePath}/lib/apis/`;
    const apiListFile = path.resolve(apiFolder, 'index.js');
    const apiListCode = ElasticApiParser.loadApiListFile(apiListFile);

    // parsing elasticsearch module 13.x and above
    //   get '5.3'() { return require('./5_3'); },
    const re = new RegExp(`\\'${version}\\'\\(\\).*require\\(\\'(.+)\\'\\)`, 'gi');
    const match = re.exec(apiListCode);
    if (match && match[1]) {
      return path.resolve(apiFolder, `${match[1]}.js`);
    }

    // parsing elasticsearch module 12.x and below
    //   '5.0': require('./5_0'),
    const re12 = new RegExp(`\\'${version}\\':\\srequire\\(\\'(.+)\\'\\)`, 'gi');
    const match12 = re12.exec(apiListCode);
    if (match12 && match12[1]) {
      return path.resolve(apiFolder, `${match12[1]}.js`);
    }

    throw new Error(`Can not found Elastic version '${version}' in ${apiListFile}`);
  }

  static cleanUpSource(code: string): string {
    // remove invalid markup
    // {<<api-param-type-boolean,`Boolean`>>} converted to {Boolean}
    let codeCleaned = code.replace(/{<<.+`(.*)`.+}/gi, '{$1}');

    // replace api.indices.prototype['delete'] = ca({
    // on api.indices.prototype.delete = ca({
    codeCleaned = codeCleaned.replace(/(api.*)\['(.+)'\](.*ca)/gi, '$1.$2$3');

    return codeCleaned;
  }

  static parseParamsDescription(doxItemAST: any): { [fieldName: string]: string | undefined } {
    const descriptions = {} as Record<string, string | undefined>;
    if (Array.isArray(doxItemAST.tags)) {
      doxItemAST.tags.forEach((tag: any) => {
        if (!tag || tag.type !== 'param') return;
        if (tag.name === 'params') return;

        const name = ElasticApiParser.cleanupParamName(tag.name);
        if (!name) return;

        descriptions[name] = ElasticApiParser.cleanupDescription(tag.description);
      });
    }
    return descriptions;
  }

  static cleanupDescription(str: string): string | undefined {
    if (typeof str === 'string') {
      if (str.startsWith('- ')) {
        str = str.substr(2);
      }
      str = str.trim();

      return str;
    }
    return undefined;
  }

  static cleanupParamName(str: string): string | undefined {
    if (typeof str === 'string') {
      if (str.startsWith('params.')) {
        str = str.substr(7);
      }
      str = str.trim();

      return str;
    }
    return undefined;
  }

  static codeToSettings(code: string): ElasticCaSettingsT | undefined {
    // find code in ca({});
    const reg = /ca\((\{(.|\n)+\})\);/g;
    const matches = reg.exec(code);
    if (matches && matches[1]) {
      return eval('(' + matches[1] + ')'); // eslint-disable-line no-eval
    }
    return undefined;
  }

  static getMethodName(str: string): string | string[] {
    const parts = str.split('.');
    if (parts[0] === 'api') {
      parts.shift();
    }
    if (parts.length === 1) {
      return parts[0];
    } else {
      return parts.filter((o) => o !== 'prototype');
    }
  }

  static parseSource(source: string): ElasticParsedSourceT {
    const result = {} as ElasticParsedSourceT;

    if (!source || typeof source !== 'string') {
      throw Error('Empty source. It should be non-empty string.');
    }

    const doxAST = dox.parseComments(source, { raw: true });
    if (!doxAST || !Array.isArray(doxAST)) {
      throw Error('Incorrect response from dox.parseComments');
    }

    doxAST.forEach((item) => {
      if (!item.ctx || !item.ctx.string) {
        return;
      }

      // method description
      let description;
      if (item.description && item.description.full) {
        description = ElasticApiParser.cleanupDescription(item.description.full);
      }

      const elasticMethod = ElasticApiParser.getMethodName(item.ctx.string);
      const dottedMethodName = Array.isArray(elasticMethod)
        ? elasticMethod.join('.')
        : elasticMethod;

      result[dottedMethodName] = {
        elasticMethod,
        description,
        argsSettings: ElasticApiParser.codeToSettings(item.code),
        argsDescriptions: ElasticApiParser.parseParamsDescription(item),
      };
    });

    return result;
  }

  generateFieldMap(): ObjectTypeComposerFieldConfigAsObjectDefinition<any, any> {
    const result = {} as ObjectTypeComposerFieldConfigAsObjectDefinition<any, any>;
    Object.keys(this.parsedSource).forEach((methodName) => {
      result[methodName] = this.generateFieldConfig(methodName);
    });

    const fieldMap = this.reassembleNestedFields(result);
    return reorderKeys(fieldMap, [
      'cat',
      'cluster',
      'indices',
      'ingest',
      'nodes',
      'snapshot',
      'tasks',
      'search',
    ]);
  }

  generateFieldConfig(methodName: string, methodArgs?: { [paramName: string]: any }) {
    if (!methodName) {
      throw new Error(`You should provide Elastic search method.`);
    }

    if (!this.parsedSource[methodName]) {
      throw new Error(`Elastic search method '${methodName}' does not exists.`);
    }

    const { description, argsSettings, argsDescriptions, elasticMethod } =
      this.parsedSource[methodName];

    const argMap = this.settingsToArgMap(argsSettings, argsDescriptions);

    return {
      type: 'JSON',
      description,
      args: argMap,
      // eslint-disable-next-line no-unused-vars
      resolve: (_source: any, args: any, context: any, _info: any) => {
        const client = (context && context.elasticClient) || this.elasticClient;

        if (!client) {
          throw new Error(
            'You should provide `elasticClient` when created types via ' +
              '`opts.elasticClient` or in runtime via GraphQL context'
          );
        }

        if (!args.body.q) {
          delete args.defaultOperator;
        }

        if (!args.body.suggestField) {
          delete args.suggestMode;
        }

        if (Array.isArray(elasticMethod)) {
          return client[elasticMethod[0]][elasticMethod[1]]({
            ...methodArgs,
            ...args,
          });
        }
        return client[elasticMethod]({ ...methodArgs, ...args });
      },
    };
  }

  paramToGraphQLArgConfig(
    paramCfg: ElasticParamConfigT,
    fieldName: string,
    description?: string
  ): ObjectTypeComposerArgumentConfigDefinition {
    const result = {
      type: this.paramTypeToGraphQL(paramCfg, fieldName),
    } as ObjectTypeComposerArgumentConfigAsObjectDefinition;

    if (paramCfg.default) {
      result.defaultValue = paramCfg.default;
      if (result.type === 'Float' || result.type === 'Int') {
        const defaultNumber = Number(result.defaultValue);
        if (Number.isNaN(defaultNumber)) {
          // Handle broken data where default is not valid for the given type
          // https://github.com/graphql-compose/graphql-compose-elasticsearch/issues/49
          delete result.defaultValue;
        } else {
          result.defaultValue = defaultNumber;
        }
      } else if (result.type === 'Boolean') {
        const t = result.defaultValue;
        result.defaultValue = t === 'true' || t === '1' || t === true;
      }
    } else if (fieldName === 'format') {
      result.defaultValue = 'json';
    }

    if (description) {
      result.description = description;
    }

    if (Array.isArray(result.defaultValue)) {
      result.type = [result.type] as any;
    }

    return result;
  }

  paramTypeToGraphQL(
    paramCfg: ElasticParamConfigT,
    fieldName: string
  ): EnumTypeComposer<any> | string {
    switch (paramCfg.type) {
      case 'string':
        return 'String';
      case 'boolean':
        return 'Boolean';
      case 'number':
        return 'Float';
      case 'time':
        return 'String';
      case 'list':
        return 'JSON';
      case 'enum':
        if (Array.isArray(paramCfg.options)) {
          return this.getEnumType(fieldName, paramCfg.options);
        }
        return 'String';
      case undefined:
        // some fields may not have type definition in API file,
        // eg '@param {anything} params.operationThreading - ?'
        return 'JSON';
      default:
        // console.log(
        //   // eslint-disable-line
        //   `New type '${paramCfg.type}' in elastic params setting for field ${fieldName}.`
        // );
        return 'JSON';
    }
  }

  getEnumType(fieldName: string, values: ReadonlyArray<any>): EnumTypeComposer<any> {
    const key = fieldName;
    const subKey = JSON.stringify(values);

    if (!this.cachedEnums[key]) {
      this.cachedEnums[key] = {};
    }

    if (!this.cachedEnums[key][subKey]) {
      const enumValues = values.reduce((result, val) => {
        if (val === '') {
          result.empty_string = { value: '' };
        } else if (val === 'true') {
          result.true_string = { value: 'true' };
        } else if (val === true) {
          result.true_boolean = { value: true };
        } else if (val === 'false') {
          result.false_string = { value: 'false' };
        } else if (val === false) {
          result.false_boolean = { value: false };
        } else if (val === 'null') {
          result.null_string = { value: 'null' };
        } else if (Number.isFinite(val)) {
          result[`number_${val}`] = { value: val };
        } else if (typeof val === 'string') {
          result[val] = { value: val };
        }
        return result;
      }, {});

      const n = Object.keys(this.cachedEnums[key]).length;
      const postfix = n === 0 ? '' : `_${n}`;

      this.cachedEnums[key][subKey] = EnumTypeComposer.createTemp({
        name: `${this.prefix}Enum_${upperFirst(fieldName)}${postfix}`,
        values: enumValues,
      });
    }

    return this.cachedEnums[key][subKey];
  }

  settingsToArgMap(
    settings?: ElasticCaSettingsT,
    descriptions: ElasticParsedArgsDescriptionsT = {}
  ): ObjectTypeComposerArgumentConfigAsObjectDefinition {
    const result = {} as ObjectTypeComposerArgumentConfigAsObjectDefinition;
    const { params, urls, url, method, needBody } = settings || {};

    if (method === 'POST' || method === 'PUT') {
      result.body = {
        type: needBody ? 'JSON!' : 'JSON',
      };
    }

    if (params) {
      Object.keys(params).forEach((k) => {
        const fieldConfig = this.paramToGraphQLArgConfig(params[k], k, descriptions[k]);
        if (fieldConfig) {
          result[k] = fieldConfig;
        }
      });
    }

    const urlList = urls || (url ? [url] : null);

    if (Array.isArray(urlList)) {
      urlList.forEach((item) => {
        if (item.req) {
          Object.keys(item.req).forEach((k) => {
            const fieldConfig = this.paramToGraphQLArgConfig(item.req[k], k, descriptions[k]);
            if (fieldConfig) {
              result[k] = fieldConfig;
            }
          });
        }
      });
    }

    return result;
  }

  reassembleNestedFields(
    fields: ObjectTypeComposerFieldConfigMapDefinition<any, any>
  ): ObjectTypeComposerFieldConfigAsObjectDefinition<any, any> {
    const result = {} as ObjectTypeComposerFieldConfigAsObjectDefinition<any, any>;
    Object.keys(fields).forEach((k) => {
      const names = k.split('.');
      if (names.length === 1) {
        result[names[0]] = fields[k];
      } else {
        if (!result[names[0]]) {
          result[names[0]] = {
            type: ObjectTypeComposer.createTemp({
              name: `${this.prefix}_${upperFirst(names[0])}`,
              // fields: (() => {}),
            }),
            resolve: () => {
              return {};
            },
          };
        }
        result[names[0]].type.setField(names[1], fields[k]);
      }
    });

    return result;
  }
}
