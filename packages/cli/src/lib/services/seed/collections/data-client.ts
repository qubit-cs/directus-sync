import { DirectusId, Query } from '../../collections';
import { DirectusUnknownType } from '../../interfaces';
import { MigrationClient } from '../../migration-client';
import { Inject, Service } from 'typedi';
import { COLLECTION, SCHEMA_CLIENT } from '../constants';
import deepmerge from 'deepmerge';
import { createOne, deleteOne, readMany, updateOne } from './requests';
import { SchemaClient, Type } from '../global';
import { LoggerService, Logger } from '../../logger';

@Service()
export class SeedDataClient {
  protected readonly logger: Logger;

  constructor(
    protected readonly loggerService: LoggerService,
    protected readonly migrationClient: MigrationClient,
    @Inject(SCHEMA_CLIENT) protected readonly schemaClient: SchemaClient,
    @Inject(COLLECTION) protected readonly collection: string,
  ) {
    this.logger = this.loggerService.getChild(collection);
  }

  /**
   * Request data from the collection
   */
  async query<T extends DirectusUnknownType>(query: Query<T>): Promise<T[]> {
    const directus = await this.migrationClient.get();

    // Debug: Log the query before sending
    this.logger.debug({
      collection: this.collection,
      query: JSON.stringify(query).substring(0, 500),
      filterKeys: query.filter ? Object.keys(query.filter) : [],
      fields: query.fields,
      limit: query.limit,
    }, 'Executing query via Directus SDK');

    let response;
    try {
      response = await directus.request<T | T[]>(
        readMany(this.collection, query),
      );
    } catch (error) {
      this.logger.error({
        collection: this.collection,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, 'SDK request failed');
      throw error;
    }

    this.logger.debug({
      collection: this.collection,
      responseType: typeof response,
      isArray: Array.isArray(response),
      responseIsNull: response === null,
      responseIsUndefined: response === undefined,
    }, 'Raw SDK response type check');

    if (Array.isArray(response)) {
      this.logger.debug({
        collection: this.collection,
        responseLength: response.length,
        firstItemKeys: response[0] ? Object.keys(response[0]) : [],
      }, 'SDK returned array response');
      return response;
    }

    // Some collections return a single object instead of an array
    if (!response || typeof response !== 'object') {
      this.logger.debug({
        collection: this.collection,
        responseType: typeof response,
      }, 'SDK returned non-object, returning empty array');
      return [];
    }

    this.logger.debug({
      collection: this.collection,
      responseKeys: Object.keys(response),
    }, 'SDK returned single object, wrapping in array');
    return [response];
  }

  /**
   * Query by primary field (one or multiple values)
   */
  async queryByPrimaryField<T extends DirectusUnknownType>(
    values: string | string[],
    query: Query<T> = {},
  ): Promise<T[]> {
    const primaryField = await this.schemaClient.getPrimaryField(
      this.collection,
    );
    const isNumber = primaryField.type === Type.Integer;
    const isArray = Array.isArray(values);
    const castedValues = isNumber
      ? isArray
        ? values.map(Number)
        : Number(values)
      : values;

    const filter: Query<T> = Array.isArray(castedValues)
      ? { filter: { [primaryField.name]: { _in: castedValues } } }
      : { filter: { [primaryField.name]: { _eq: castedValues } } };

    return await this.query<T>(deepmerge(filter, query));
  }

  /**
   * Create a new item in the collection
   */
  async create<T extends DirectusUnknownType>(data: Partial<T>): Promise<T> {
    const directus = await this.migrationClient.get();
    return await directus.request<T>(createOne(this.collection, data));
  }

  /**
   * Update an item in the collection
   */
  async update<T extends DirectusUnknownType>(
    key: DirectusId,
    data: Partial<T>,
  ): Promise<T> {
    const directus = await this.migrationClient.get();
    return await directus.request<T>(updateOne(this.collection, key, data));
  }

  /**
   * Delete an item from the collection
   */
  async delete<T extends DirectusUnknownType>(key: DirectusId): Promise<void> {
    const directus = await this.migrationClient.get();
    await directus.request<T>(deleteOne(this.collection, key));
  }
}
