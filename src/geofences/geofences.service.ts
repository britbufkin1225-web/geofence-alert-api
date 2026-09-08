import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';

/**
 * All methods take an authoritative `tenantId` (derived from the authenticated
 * principal, never from client input) and scope every query by it. Tenant
 * ownership is set server-side on create and is never accepted from, or
 * mutated by, the request body. Cross-tenant lookups resolve to 404 so a caller
 * cannot even confirm that another tenant's resource exists.
 */
@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createGeofenceDto: CreateGeofenceDto, tenantId: string) {
    return this.prisma.geofence.create({
      data: { ...createGeofenceDto, tenant: { connect: { id: tenantId } } },
    });
  }

  async findAll(query: QueryGeofencesDto, tenantId: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    // tenantId is always part of the query predicate, so listing, filtering,
    // searching and pagination can never span tenants.
    const where: Prisma.GeofenceWhereInput = { tenantId };

    if (query.active !== undefined) {
      where.isActive = query.active;
    }

    if (query.search) {
      where.name = {
        contains: query.search,
      };
    }

    const orderBy: Prisma.GeofenceOrderByWithRelationInput = {
      [sortBy]: sortOrder,
    };

    const [geofences, total] = await this.prisma.$transaction([
      this.prisma.geofence.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.geofence.count({
        where,
      }),
    ]);

    return {
      data: geofences,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
        filters: {
          active: query.active ?? null,
          search: query.search ?? null,
        },
        sort: {
          sortBy,
          sortOrder,
        },
      },
    };
  }

  async findOne(id: string, tenantId: string) {
    // Scope the lookup itself by tenant (findFirst with an id+tenantId
    // predicate) rather than fetching by id and comparing afterwards. A
    // geofence owned by another tenant is indistinguishable from a missing one.
    const geofence = await this.prisma.geofence.findFirst({
      where: {
        id,
        tenantId,
      },
    });

    if (!geofence) {
      throw new NotFoundException(`Geofence with id ${id} not found`);
    }

    return geofence;
  }

  async getSummary(tenantId: string) {
    const [total, active, inactive, radiusStats] = await Promise.all([
      this.prisma.geofence.count({ where: { tenantId } }),

      this.prisma.geofence.count({
        where: {
          tenantId,
          isActive: true,
        },
      }),

      this.prisma.geofence.count({
        where: {
          tenantId,
          isActive: false,
        },
      }),

      this.prisma.geofence.aggregate({
        where: { tenantId },
        _min: {
          radiusMeters: true,
        },
        _max: {
          radiusMeters: true,
        },
        _avg: {
          radiusMeters: true,
        },
      }),
    ]);

    return {
      total,
      active,
      inactive,
      radius: {
        min: radiusStats._min.radiusMeters ?? 0,
        max: radiusStats._max.radiusMeters ?? 0,
        average: radiusStats._avg.radiusMeters ?? 0,
      },
    };
  }

  async update(
    id: string,
    updateGeofenceDto: UpdateGeofenceDto,
    tenantId: string,
  ) {
    // Confirm ownership for the non-disclosing 404 contract, then retain the
    // tenant predicate on the mutation itself as defense in depth.
    await this.findOne(id, tenantId);

    return this.prisma.geofence.update({
      where: {
        id,
        tenantId,
      },
      data: updateGeofenceDto,
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);

    return this.prisma.geofence.delete({
      where: {
        id,
        tenantId,
      },
    });
  }
}
