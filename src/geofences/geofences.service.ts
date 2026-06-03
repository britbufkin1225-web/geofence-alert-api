import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { QueryGeofenceDto } from './dto/query-geofence.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';

@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createGeofenceDto: CreateGeofenceDto) {
    return this.prisma.geofence.create({
      data: createGeofenceDto,
    });
  }

  async findAll(query: QueryGeofenceDto) {
    const where: {
      name?: {
        contains: string;
      };
      isActive?: boolean;
    } = {};

    if (query.name) {
      where.name = {
        contains: query.name,
      };
    }

    if (query.active !== undefined) {
      where.isActive = query.active === 'true';
    }

    return this.prisma.geofence.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
    });
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
