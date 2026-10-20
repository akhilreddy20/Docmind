import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../common/database.service';

export interface AuthUser {
  id: string;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService) {}

  async register(email: string, password: string) {
    const hash = await bcrypt.hash(password, 10);
    const user = await this.db
      .one<AuthUser>(
        `INSERT INTO users (email, password_hash) VALUES (lower($1), $2) RETURNING id, email`,
        [email, hash],
      )
      .catch((err) => {
        if (err.code === '23505') throw new ConflictException('Email already registered');
        throw err;
      });
    return this.issue(user!);
  }

  async login(email: string, password: string) {
    const row = await this.db.one<AuthUser & { password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = lower($1)`,
      [email],
    );
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issue({ id: row.id, email: row.email });
  }

  private issue(user: AuthUser) {
    return { accessToken: this.jwt.sign({ sub: user.id, email: user.email }), user };
  }
}
