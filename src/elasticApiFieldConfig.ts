/* eslint-disable no-param-reassign */

import { ObjectTypeComposer, graphql } from 'graphql-compose';
import type { GraphQLFieldConfig } from 'graphql';
import elasticsearch from 'elasticsearch';
import ElasticApiParser from './ElasticApiParser';

const DEFAULT_ELASTIC_API_VERSION = '_default';
const { GraphQLString } = graphql;

export function elasticApiFieldConfig(esClientOrOpts: any): GraphQLFieldConfig<any, any> {
  if (!esClientOrOpts || typeof esClientOrOpts !== 'object') {
    throw new Error(
      'You should provide ElasticClient instance or ElasticClientConfig in first argument.'
    );
  }

  if (isElasticClient(esClientOrOpts)) {
    return instanceElasticClient(esClientOrOpts);
  } else {
    return contextElasticClient(esClientOrOpts);
  }
}

function instanceElasticClient(elasticClient: Record<string, any>): GraphQLFieldConfig<any, any> {
  const apiVersion = elasticClient.transport._config
    ? elasticClient.transport._config.apiVersion
    : DEFAULT_ELASTIC_API_VERSION;
  const prefix = `ElasticAPI${apiVersion.replace('.', '')}`;

  const apiParser = new ElasticApiParser({
    elasticClient,
    prefix,
  });

  return {
    description: `Elastic API v${apiVersion}`,
    type: ObjectTypeComposer.createTemp({
      name: prefix,
      fields: apiParser.generateFieldMap(),
    }).getType(),
    resolve: () => ({}),
  };
}

function contextElasticClient(elasticConfig: Record<string, any>): GraphQLFieldConfig<any, any> {
  if (!elasticConfig.apiVersion) {
    elasticConfig.apiVersion = DEFAULT_ELASTIC_API_VERSION;
  }
  const { apiVersion } = elasticConfig;
  const prefix = `ElasticAPI${apiVersion.replace('.', '')}`;

  const apiParser = new ElasticApiParser({
    apiVersion,
    prefix,
  });

  return {
    description: `Elastic API v${apiVersion}`,
    type: ObjectTypeComposer.createTemp({
      name: prefix,
      fields: apiParser.generateFieldMap(),
    }).getType(),
    args: {
      host: {
        type: GraphQLString,
        defaultValue: elasticConfig.host || 'http://user:pass@localhost:9200',
      },
    },
    resolve: (_: any, args: Record<string, any>, context: Record<string, any>) => {
      if (typeof context === 'object') {
        const opts = args.host
          ? {
              ...elasticConfig,
              host: args.host,
            }
          : elasticConfig;
        context.elasticClient = new elasticsearch.Client(opts);
      }
      return {};
    },
  };
}

function isElasticClient(obj: any) {
  if (obj instanceof elasticsearch.Client) {
    return true;
  }

  if (obj && obj.transport && obj.transport.name === 'elasticsearch-js') {
    return true;
  }

  if (obj && obj.transport && obj.transport._config && obj.transport._config.__reused) {
    return true;
  }

  return false;
}
