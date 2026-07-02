boolean Collider(Player Bat, Encounter Enc) {
  // Calculate distance
  float distance = dist(Bat.PlayerX, Bat.PlayerY, Enc.PreyX, Enc.PreyY); 

  //Prey Death Case//
  if (distance < (Bat.r + Enc.r)/2 && Enc.Rank<Bat.RankPlayer ) {  // Compare Rank and radians excluded distance.
    Bat.P2Slide=false;
    Bat.CountDiveSad=0;
    Bat.CountDiveHappy=0;
    Bat.CountIdleHappy = 0;

    Enc.PreyAtk=true;

    Enc.CountDive=Enc.CountDive+1;

    if (Enc.CountSwitch==14) {
      Enc.Rank=-1;  //Dying
    }

    if (Enc.CountSwitch>16) {
      Enc.CountDying++;
      Enc.Rank=-2;  //Died
    }
    if (Enc.CountDying==1) {
      SoundDeath.play();
      Bat.PreyCounted = Bat.PreyCounted+10; //Prey counted on UI 
      //print("Counted");
    } 

    if (Enc.CountDive==1 && Enc.Rank<Bat.RankPlayer  ) {
      Bat.Anim=1;  //Bat Dive Case
      print("yummy_");
      if (Enc.Rank==0)   println("Worm"); 
      if (Enc.Rank==1)   println("Spider"); 
      if (Enc.Rank==2)   println("Bug");
    }
    if (Enc.CountDive>0)
      Enc.CountDive++;

    //Vacuum Preys//
    if (Enc.PreyY>Bat.PlayerY || Enc.PreyY<Bat.PlayerY) {    //Blow Preys on Y axis
      Enc.PreyY+=1;
      //if (Enc.PreyY==Bat.PlayerY)
      //  Enc.PreyY=Enc.PreyY; //Daymn
    } 
    if (Enc.PreyX>Bat.PlayerX && Enc.PreyX > Bat.PlayerX+3) {    //Vaccuum Preys on X axis
      Enc.PreyX-=Enc.Speed/2;
    } else if (Enc.PreyX<Bat.PlayerX && Enc.PreyX < Bat.PlayerX+3) {
      Enc.PreyX+=Enc.Speed/2;
    }

    return true;

    //Prey Attack Case//
  } else {
    if (distance < (Bat.r + Enc.r)/2 && Enc.Rank>=Bat.RankPlayer) {  // Compare Rank and radians excluded distance.

      Enc.PreyAtk=true;
      Bat.CountDiveSad=0;
      Bat.CountDiveHappy=0;
      Bat.CountIdleHappy = 0;
      Enc.TakeHealth++;
      Enc.CountDive++;
      if (Enc.CountDive==1 && Enc.TakeHealth==1) {
        Bat.Health = Bat.Health-10;    //How much player die
        Bat.Anim=2;  //Bat Dive CaseFailed
        print("ouch__");
        if (Enc.Rank==100)   println("Rock"); 
        if (Enc.Rank==101)   println("Cone");
        if (Enc.Rank==1)   println("Spider"); 
        if (Enc.Rank==2)   println("Bug");
      }

      if (Enc.PreyAtk)
        Bat.P2Slide=false;


      //Death reaction
      fill(BloodRed, 100-Enc.TakeHealth*4);
      rectMode(CENTER);
      rect(width/2, height/2, width, height);
      rectMode(CORNER);

      if ( Enc.Rank<100) {

        //Blow Preys//
        if (Enc.PreyY>Bat.PlayerY) {    //Blow Preys on Y axis
          Enc.PreyY+=2;
        } else if (Enc.PreyY<Bat.PlayerY) {    //Blow Preys on Y axis
          Enc.PreyY-=2;
        } 
        if (Enc.PreyX>Bat.PlayerX) {    //Blow Preys on X axis
          Enc.PreyX+=2;
        } else if (Enc.PreyX<Bat.PlayerX) {
          Enc.PreyX-=2;
        }
      }
    }
    return false;
  }
}
