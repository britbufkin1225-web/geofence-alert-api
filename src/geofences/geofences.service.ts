import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';

@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createGeofenceDto: CreateGeofenceDto) {
    return this.prisma.geofence.create({
      data: createGeofenceDto,
    });
  }

  async findAll(paginationQuery: PaginationQueryDto) {
    const page = paginationQuery.page ?? 1;
    const limit = paginationQuery.limit ?? 10;
    const skip = (page - 1) * limit;

    const [geofences, total] = await this.prisma.$transaction([
      this.prisma.geofence.findMany({
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.geofence.count(),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: geofences,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
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
