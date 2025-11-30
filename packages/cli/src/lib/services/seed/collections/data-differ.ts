import { DirectusId, WithSyncId, IdMap } from '../../collections';
import { DirectusUnknownType } from '../../interfaces';
import { SeedDataClient } from './data-client';
import { SeedDataMapper } from './data-mapper';
import { Inject, Service } from 'typedi';
import { COLLECTION, META, SCHEMA_CLIENT } from '../constants';
import { LoggerService, Logger } from '../../logger';
import { diff } from 'deep-object-diff';
import { SeedMeta } from '../interfaces';
import { Cacheable } from 'typescript-cacheable';
import {
  SchemaClient,
  SeedIdMapperClient,
  SeedIdMapperClientFactory,
} from '../global';

@Service()
export class SeedDataDiffer {
  protected readonly logger: Logger;
  protected readonly idMapper: SeedIdMapperClient;

  constructor(
    protected readonly loggerService: LoggerService,
    @Inject(COLLECTION) protected readonly collection: string,
    @Inject(META) protected readonly meta: SeedMeta,
    protected readonly dataClient: SeedDataClient,
    protected readonly dataMapper: SeedDataMapper,
    protected readonly idMapperFactory: SeedIdMapperClientFactory,
    @Inject(SCHEMA_CLIENT) protected readonly schemaClient: SchemaClient,
  ) {
    this.logger = this.loggerService.getChild(collection);
    this.idMapper = this.idMapperFactory.forCollection(collection);
  }

  /**
   * Get fields to ignore
   * Keep the response in cache
   */
  @Cacheable()
  protected async getFieldsToIgnore() {
    return [
      await this.getPrimaryFieldName(),
      '_syncId',
      ...this.meta.ignore_on_update,
    ];
  }

  /**
   * Get the diff between source data and target data
   */
  async getDiff(data: WithSyncId<DirectusUnknownType>[]) {
    const toCreate: WithSyncId<DirectusUnknownType>[] = [];
    const toUpdate: {
      sourceItem: WithSyncId<DirectusUnknownType>;
      targetItem: WithSyncId<DirectusUnknownType>;
      diffItem: Partial<WithSyncId<DirectusUnknownType>>;
    }[] = [];
    const unchanged: WithSyncId<DirectusUnknownType>[] = [];

    for (const sourceItem of data) {
      const targetItem = await this.getTargetItem(sourceItem);
      if (targetItem) {
        const { hasDiff, diffObject } = await this.getDiffBetweenItems(
          sourceItem,
          targetItem,
        );
        if (hasDiff) {
          toUpdate.push({ sourceItem, targetItem, diffItem: diffObject });
        } else {
          unchanged.push(targetItem);
        }
      } else {
        toCreate.push(sourceItem);
      }
    }

    // Get manually deleted ids
    const dangling = await this.getDanglingIds();

    // Get items to delete
    const toDelete = await this.getIdsToDelete(unchanged, toUpdate, dangling);

    return { toCreate, toUpdate, toDelete, unchanged, dangling };
  }

  /**
   * Get the target item from the idMapper then from the target table
   */
  protected async getTargetItem(
    sourceItem: WithSyncId<DirectusUnknownType>,
  ): Promise<WithSyncId<DirectusUnknownType> | undefined> {
    const idMap = await this.idMapper.getBySyncId(sourceItem._syncId);
    if (!idMap) {
      return undefined;
    }

    try {
      const [targetItem] = await this.dataClient.queryByPrimaryField(
        idMap.local_id,
      );

      if (!targetItem) {
        return undefined;
      }

      // Remove all fields that are not in the source item
      const targetItemWithoutFields = Object.keys(sourceItem).reduce(
        (acc, field) => {
          acc[field] = targetItem[field];
          return acc;
        },
        {} as DirectusUnknownType,
      );

      const withSyncId = {
        ...targetItemWithoutFields,
        _syncId: sourceItem._syncId,
      };
      const [withMappedIds] =
        await this.dataMapper.mapIdsToSyncIdAndRemoveIgnoredFields([
          withSyncId,
        ]);
      const primaryFieldName = await this.getPrimaryFieldName();
      return {
        ...withMappedIds,
        [primaryFieldName]: idMap.local_id,
      } as WithSyncId<DirectusUnknownType>;
    } catch (error) {
      this.logger.warn(
        { error, idMap },
        `Could not find item with id ${idMap.local_id}`,
      );
      return undefined;
    }
  }

  /**
   * Get the diff between two items and returns the source item with only the diff fields
   */
  protected async getDiffBetweenItems(
    sourceItem: WithSyncId<DirectusUnknownType>,
    targetItem: WithSyncId<DirectusUnknownType>,
  ) {
    const diffObject = diff(targetItem, sourceItem) as Partial<
      WithSyncId<DirectusUnknownType>
    >;

    const fieldsToIgnore = await this.getFieldsToIgnore();
    for (const field of fieldsToIgnore) {
      delete diffObject[field];
    }

    const diffFields = Object.keys(diffObject);
    const sourceDiffObject = {} as Partial<WithSyncId<DirectusUnknownType>>;

    for (const field of diffFields) {
      sourceDiffObject[field] = sourceItem[field];
    }

    return {
      diffObject: sourceDiffObject,
      hasDiff: diffFields.length > 0,
    };
  }

  /**
   * Get manually deleted items
   */
  async getDanglingIds(): Promise<IdMap[]> {
    const allIdsMap = await this.idMapper.getAll();
    const localIds = allIdsMap.map((item) => item.local_id);

    if (!localIds.length) {
      return [];
    }

    const primaryFieldName = await this.getPrimaryFieldName();
    this.logger.debug({
      collection: this.collection,
      primaryFieldName,
      localIdsCount: localIds.length,
      firstFewIds: localIds.slice(0, 3),
    }, 'About to query for existing items to check for dangling IDs');

    // Batch queries to avoid issues with large _in filters
    // Query in chunks of 100 IDs to prevent SDK/API issues with large arrays
    const BATCH_SIZE = 100;
    const existingItems = [];

    for (let i = 0; i < localIds.length; i += BATCH_SIZE) {
      const batch = localIds.slice(i, i + BATCH_SIZE);
      this.logger.debug({
        collection: this.collection,
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        batchSize: batch.length,
        totalBatches: Math.ceil(localIds.length / BATCH_SIZE),
      }, 'Querying batch of IDs');

      const batchItems = await this.dataClient.queryByPrimaryField(batch, {
        limit: -1,
        fields: [primaryFieldName],
      });

      existingItems.push(...batchItems);
    }

    this.logger.debug({
      collection: this.collection,
      existingItemsCount: existingItems.length,
      firstItem: existingItems[0],
      firstItemKeys: existingItems[0] ? Object.keys(existingItems[0]) : [],
    }, 'Query returned existing items (all batches combined)');

    const existingIds = new Set<DirectusId>();
    for (const item of existingItems) {
      const primaryKey = await this.getPrimaryKey(item);

      // Debug: Log when primaryKey is undefined to understand the root cause
      if (primaryKey === undefined || primaryKey === null) {
        this.logger.warn({
          collection: this.collection,
          primaryFieldName,
          item,
          itemKeys: Object.keys(item),
        }, 'Primary key is undefined for item - this indicates a mismatch between expected and actual fields');
        throw new Error(
          `Primary key "${primaryFieldName}" is undefined for item in collection "${this.collection}". ` +
          `Item has fields: ${Object.keys(item).join(', ')}. ` +
          `This suggests the query did not return the expected primary field.`
        );
      }

      existingIds.add(primaryKey.toString());
    }

    return allIdsMap.filter((item) => !existingIds.has(item.local_id));
  }

  /**
   * Get items that should be deleted
   */
  protected async getIdsToDelete(
    unchanged: WithSyncId<DirectusUnknownType>[],
    toUpdate: {
      sourceItem: WithSyncId<DirectusUnknownType>;
      targetItem: WithSyncId<DirectusUnknownType>;
    }[],
    dangling: IdMap[],
  ): Promise<IdMap[]> {
    const allIdsMap = await this.idMapper.getAll();
    const toKeepIds = new Set([
      ...unchanged.map((item) => item._syncId),
      ...toUpdate.map(({ targetItem }) => targetItem._syncId),
      ...dangling.map((item) => item.sync_id),
    ]);

    return allIdsMap.filter((item) => !toKeepIds.has(item.sync_id));
  }

  /**
   * Get the primary key from an item
   */
  protected async getPrimaryKey(
    item: DirectusUnknownType,
  ): Promise<DirectusId> {
    const primaryFieldName = await this.getPrimaryFieldName();
    return item[primaryFieldName] as DirectusId;
  }

  /**
   * Get the primary field name from the collection
   */
  protected async getPrimaryFieldName(): Promise<string> {
    return (await this.schemaClient.getPrimaryField(this.collection)).name;
  }
}
