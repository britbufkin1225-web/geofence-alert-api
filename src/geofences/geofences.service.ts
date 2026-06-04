import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { QueryGeofencesDto } from './dto/query-geofences.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';

@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createGeofenceDto: CreateGeofenceDto) {
    return this.prisma.geofence.create({
      data: createGeofenceDto,
    });
  }

  async findAll(query: QueryGeofencesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where: Prisma.GeofenceWhereInput = {};

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

  async findOne(id: string) {
    const geofence = await this.prisma.geofence.findUnique({
      where: {
        id,
      },
    });

    if (!geofence) {
      throw new NotFoundException(`Geofence with id ${id} not found`);
    }

    return geofence;
  }

  async update(id: string, updateGeofenceDto: UpdateGeofenceDto) {
    await this.findOne(id);

    return this.prisma.geofence.update({
      where: {
        id,
      },
      data: updateGeofenceDto,
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.geofence.delete({
      where: {
        id,
      },
    });
  }
}
