interface Profile {
  id: string;
  role: 'tenant' | 'landlord' | 'estate_manager' | 'artisan' | 'agent' | 'admin';
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  bio: string | null;
  phone_verified: boolean;
  nin_verified: boolean;
  verification_status: 'unverified' | 'partially_verified' | 'verified';
  onboarding_completed: boolean;
  expo_push_token: string | null;
  rating_avg: number;
  rating_count: number;
  is_suspended: boolean;
  created_at: string;
}

declare namespace Express {
  interface Request {
    user: Profile;
    rawBody?: Buffer;
  }
}
